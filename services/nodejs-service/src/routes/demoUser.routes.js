const express = require('express');
const { signup, login } = require('../controllers/demoUser.controller');
const { body } = require('express-validator');
const upload = require('../middlewares/upload.middleware');

const router = express.Router();

/**
 * @swagger
 * /api/demo-users/signup:
 *   post:
 *     summary: Register a new demo user
 *     tags: [Demo Users]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             $ref: '#/components/schemas/DemoUserSignup'
 *     responses:
 *       201:
 *         description: User registered successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SuccessResponse'
 *       400:
 *         description: Validation error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       409:
 *         description: Email or phone number already exists
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post('/signup',
  upload.fields([
    { name: 'address_proof_image', maxCount: 1 },
    { name: 'id_proof_image', maxCount: 1 }
  ]),
  [
    body('name').notEmpty(),
    body('phone_number').notEmpty(),
    body('email').isEmail(),
    body('password').isLength({ min: 6 }),
    body('city').notEmpty(),
    body('state').notEmpty(),
    body('country').notEmpty(),
    body('pincode').notEmpty(),
    body('security_question').notEmpty(),
    body('security_answer').notEmpty(),
    body('is_active').notEmpty().isInt({ min: 0, max: 1 }).withMessage('is_active must be 0 or 1'),
    body('address_proof_image').optional(),
    body('id_proof_image').optional(),
  ],
  signup
);

/**
 * @swagger
 * /api/demo-users/login:
 *   post:
 *     summary: Login a demo user
 *     tags: [Demo Users]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - password
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *               password:
 *                 type: string
 *     responses:
 *       200:
 *         description: Login successful
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SuccessResponse'
 *       401:
 *         description: Invalid credentials
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       429:
 *         description: Too many login attempts
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post('/login',
  [
    body('email').isEmail(),
    body('password').notEmpty(),
  ],
  login
);

module.exports = router; 