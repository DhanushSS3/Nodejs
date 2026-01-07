
const { body } = require('express-validator');
const validator = require('validator');

const mamLoginValidation = [
  body('email')
    .custom((value, { req }) => {
      const email = (value || req.body.login_email || '').trim();
      if (!email) {
        throw new Error('email is required');
      }
      if (!validator.isEmail(email)) {
        throw new Error('email must be a valid email');
      }
      req.body.email = email.toLowerCase();
      return true;
    }),
  body('password')
    .isString().withMessage('password is required')
    .isLength({ min: 8 }).withMessage('password must be at least 8 characters long')
];

const mamRefreshValidation = [
  body('refresh_token')
    .isString().withMessage('refresh_token is required')
    .notEmpty().withMessage('refresh_token cannot be empty')
];

const mamLogoutValidation = [
  body('refresh_token')
    .optional()
    .isString().withMessage('refresh_token must be a string')
];

module.exports = {
  mamLoginValidation,
  mamRefreshValidation,
  mamLogoutValidation
};
