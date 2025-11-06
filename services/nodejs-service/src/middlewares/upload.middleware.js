const multer = require('multer');
const path = require('path');

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, path.join(__dirname, '../../uploads'));
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + '-' + file.originalname.replace(/\s+/g, ''));
  }
});

/**
 * Enhanced file validation function
 * @param {Object} req - Express request object
 * @param {Object} file - Multer file object
 * @param {Function} cb - Callback function
 */
const fileFilter = (req, file, cb) => {
  try {
    // Allowed MIME types for images
    const allowedMimes = [
      'image/jpeg',
      'image/jpg', 
      'image/png',
      'image/gif',
      'image/webp',
      'image/bmp',
      'image/tiff'
    ];

    // Allowed file extensions (case-insensitive)
    const allowedExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff', '.tif'];
    
    // Get file extension from original filename
    const fileExtension = path.extname(file.originalname).toLowerCase();
    
    // Validate MIME type
    if (!allowedMimes.includes(file.mimetype.toLowerCase())) {
      const error = new Error(`Invalid file type: ${file.mimetype}. Only image files (JPEG, PNG, GIF, WebP, BMP, TIFF) are allowed.`);
      error.code = 'INVALID_FILE_TYPE';
      error.field = file.fieldname;
      error.filename = file.originalname;
      return cb(error, false);
    }
    
    // Validate file extension
    if (!allowedExtensions.includes(fileExtension)) {
      const error = new Error(`Invalid file extension: ${fileExtension}. Only image files (.jpg, .jpeg, .png, .gif, .webp, .bmp, .tiff) are allowed.`);
      error.code = 'INVALID_FILE_EXTENSION';
      error.field = file.fieldname;
      error.filename = file.originalname;
      return cb(error, false);
    }
    
    // Additional validation: Check for suspicious file names
    if (file.originalname.includes('..') || file.originalname.includes('/') || file.originalname.includes('\\')) {
      const error = new Error(`Invalid filename: ${file.originalname}. Filename contains invalid characters.`);
      error.code = 'INVALID_FILENAME';
      error.field = file.fieldname;
      error.filename = file.originalname;
      return cb(error, false);
    }
    
    // File is valid
    cb(null, true);
    
  } catch (error) {
    const validationError = new Error(`File validation error: ${error.message}`);
    validationError.code = 'FILE_VALIDATION_ERROR';
    validationError.field = file.fieldname;
    validationError.filename = file.originalname;
    cb(validationError, false);
  }
};

const upload = multer({ 
  storage,
  limits: {
    fileSize: 12 * 1024 * 1024, // 12MB per individual file
    files: 2, // Maximum 2 files
    fieldSize: 1024 * 1024, // 1MB per field value
    fieldNameSize: 100, // 100 bytes per field name
    fields: 30 // Maximum 30 non-file fields (increased from 20 to accommodate all signup fields)
  },
  fileFilter
});

module.exports = upload; 