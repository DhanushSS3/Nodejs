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

    def _build_message(self, *, to_addr: str, user_type: str, user_id: str, margin_level: float, threshold: float) -> MIMEMultipart:
        msg = MIMEMultipart("alternative")
        msg["Subject"] = f"Margin Alert: Level {margin_level:.2f}% below {threshold:.0f}%"
        msg["From"] = self.sender
        msg["To"] = to_addr

        text = (
            f"Hello,\n\n"
            f"Your portfolio margin level is at {margin_level:.2f}% which is below the safe threshold ({threshold:.0f}%).\n"
            f"Account: {user_type}:{user_id}\n\n"
            f"Please add funds or reduce exposure. This is an automated alert.\n"
        )
        html = (
            f"<html><body>"
            f"<p>Hello,</p>"
            f"<p>Your portfolio margin level is at <b>{margin_level:.2f}%</b> which is below the safe threshold (<b>{threshold:.0f}%</b>).</p>"
            f"<p>Account: <code>{user_type}:{user_id}</code></p>"
            f"<p>Please add funds or reduce exposure. This is an automated alert.</p>"
            f"</body></html>"
        )
        msg.attach(MIMEText(text, "plain"))
        msg.attach(MIMEText(html, "html"))
        return msg

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

    async def _send(self, *, user_type: str, user_id: str, email: str, margin_level: float, threshold: float) -> None:
        if not self.host or not self.port or not self.sender:
            raise RuntimeError("Email configuration missing (EMAIL_HOST/EMAIL_PORT/EMAIL_FROM)")
        msg = self._build_message(to_addr=email, user_type=user_type, user_id=user_id, margin_level=margin_level, threshold=threshold)
        await asyncio.to_thread(self._send_blocking, to_addr=email, msg=msg)

    async def send_alert(self, *, user_type: str, user_id: str, email: Optional[str], margin_level: float, threshold: float) -> bool:
        if not email:
            logger.warning("EmailNotifier: missing email for %s:%s; skipping alert.", user_type, user_id)
            return False
        # Simple bounded retry with backoff
        delays = [0.1, 0.5, 1.0]
        for i, d in enumerate(delays):
            try:
                await self._send(user_type=user_type, user_id=user_id, email=email, margin_level=margin_level, threshold=threshold)
                logger.info("[AutoCutoff Email] sent to=%s user=%s:%s ml=%.2f thr=%.0f", email, user_type, user_id, margin_level, threshold)
                return True
            except Exception as e:
                logger.warning("EmailNotifier send failed attempt=%s for %s:%s err=%s", i + 1, user_type, user_id, e)
                await asyncio.sleep(d)
        return False
