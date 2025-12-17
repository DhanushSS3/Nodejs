import logging
import asyncio
import os
import smtplib
import ssl
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from typing import Optional

logger = logging.getLogger(__name__)


class EmailNotifier:
    """
    Async SMTP email notifier with simple retry/backoff.
    Reads configuration from environment variables:
      - EMAIL_HOST, EMAIL_PORT, EMAIL_USER, EMAIL_PASS, EMAIL_FROM
    """

    def __init__(self):
        self.host = os.getenv("EMAIL_HOST", "smtp.hostinger.com")
        try:
            self.port = int(os.getenv("EMAIL_PORT", "465"))
        except Exception:
            self.port = 465
        self.username = os.getenv("EMAIL_USER")
        self.password = os.getenv("EMAIL_PASS")
        self.sender = os.getenv("EMAIL_FROM", self.username or "noreply@example.com")

    def _build_message(self, *, to_addr: str, user_type: str, user_id: str, account_number: str, margin_level: float, threshold: float) -> MIMEMultipart:
        subject_label, body_context = self._build_contextual_text(user_type=user_type, account_number=account_number)

        msg = MIMEMultipart("alternative")
        msg["Subject"] = f"{subject_label}: Level {margin_level:.2f}% below {threshold:.0f}%"
        msg["From"] = self.sender
        msg["To"] = to_addr

        intro_line = (
            f"Your {body_context} margin level is at {margin_level:.2f}% which is below the safe threshold "
            f"({threshold:.0f}%)."
        )

        footer_line = (
            "Please add funds or reduce exposure immediately. This notification was sent to the primary "
            "live-account email associated with this profile."
        )

        text = (
            f"Hello,\n\n"
            f"{intro_line}\n"
            f"Account Reference: {account_number}\n\n"
            f"{footer_line}\n"
        )
        html = (
            f"<html><body>"
            f"<p>Hello,</p>"
            f"<p>{intro_line}</p>"
            f"<p><strong>Account Reference:</strong> <code>{account_number}</code></p>"
            f"<p>{footer_line}</p>"
            f"</body></html>"
        )
        msg.attach(MIMEText(text, "plain"))
        msg.attach(MIMEText(html, "html"))
        return msg

    def _build_contextual_text(self, *, user_type: str, account_number: str) -> tuple[str, str]:
        normalized = (user_type or "").lower()
        if normalized == "strategy_provider":
            return (
                "Strategy Provider Margin Alert",
                f"strategy provider account ({account_number})"
            )
        if normalized == "copy_follower":
            return (
                "Copy Follower Margin Alert",
                f"copy follower account ({account_number})"
            )
        if normalized == "demo":
            return (
                "Demo Account Margin Alert",
                f"demo account ({account_number})"
            )
        return (
            "Margin Alert",
            f"live trading account ({account_number})"
        )

    def _send_blocking(self, *, to_addr: str, msg: MIMEMultipart) -> None:
        # Use SSL for port 465, otherwise STARTTLS
        if self.port == 465:
            context = ssl.create_default_context()
            with smtplib.SMTP_SSL(self.host, self.port, context=context, timeout=15) as server:
                if self.username and self.password:
                    server.login(self.username, self.password)
                server.sendmail(self.sender, [to_addr], msg.as_string())
        else:
            with smtplib.SMTP(self.host, self.port, timeout=15) as server:
                server.ehlo()
                try:
                    server.starttls(context=ssl.create_default_context())
                except Exception:
                    # Some servers require SSL only; proceed without STARTTLS if not supported
                    pass
                if self.username and self.password:
                    server.login(self.username, self.password)
                server.sendmail(self.sender, [to_addr], msg.as_string())

    async def _send(self, *, user_type: str, user_id: str, account_number: str, email: str, margin_level: float, threshold: float) -> None:
        if not self.host or not self.port or not self.sender:
            raise RuntimeError("Email configuration missing (EMAIL_HOST/EMAIL_PORT/EMAIL_FROM)")
        msg = self._build_message(to_addr=email, user_type=user_type, user_id=user_id, account_number=account_number, margin_level=margin_level, threshold=threshold)
        await asyncio.to_thread(self._send_blocking, to_addr=email, msg=msg)

    async def send_alert(self, *, user_type: str, user_id: str, account_number: str, email: Optional[str], margin_level: float, threshold: float) -> bool:
        if not email:
            logger.warning("EmailNotifier: missing email for %s:%s; skipping alert.", user_type, user_id)
            return False
        # Simple bounded retry with backoff
        delays = [0.1, 0.5, 1.0]
        for i, d in enumerate(delays):
            try:
                await self._send(user_type=user_type, user_id=user_id, account_number=account_number, email=email, margin_level=margin_level, threshold=threshold)
                logger.info("[AutoCutoff OTP] WARNING email sent | user=%s:%s | to=%s | ml=%.2f | thr=%.0f", user_type, user_id, email, margin_level, threshold)
                logger.info("[AutoCutoff Email] sent to=%s user=%s:%s ml=%.2f thr=%.0f", email, user_type, user_id, margin_level, threshold)
                return True
            except Exception as e:
                logger.warning("EmailNotifier send failed attempt=%s for %s:%s err=%s", i + 1, user_type, user_id, e)
                await asyncio.sleep(d)
        return False
