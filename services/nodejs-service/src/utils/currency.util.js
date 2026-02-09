function toMinorUnits(amount, minorUnit) {
  const numericAmount = typeof amount === 'string' ? parseFloat(amount) : Number(amount);
  if (!Number.isFinite(numericAmount)) {
    throw new Error('amount must be a valid number');
  }

  const unit = parseInt(minorUnit, 10);
  if (!Number.isFinite(unit) || unit < 0) {
    throw new Error('minorUnit must be a non-negative integer');
  }

  const factor = Math.pow(10, unit);
  return Math.round(numericAmount * factor);
}

module.exports = {
  toMinorUnits,
};
