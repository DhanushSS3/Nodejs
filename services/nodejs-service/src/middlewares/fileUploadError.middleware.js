const multer = require('multer');
const logger = require('../services/logger.service');

/**
 * Middleware to handle multer file upload errors
 * This middleware catches multer errors and converts them to proper HTTP responses
 * before they reach the controller
 */
const handleFileUploadErrors = (error, req, res, next) => {
  // Log the error for debugging
  logger.error('File upload error occurred', {
    error: error.message,
    code: error.code,
    field: error.field,
    filename: error.filename,
    stack: error.stack
  });

  // Handle multer-specific errors
  if (error instanceof multer.MulterError) {
    switch (error.code) {
      case 'LIMIT_FILE_SIZE':
        return res.status(400).json({
          success: false,
          message: 'File too large. Maximum file size is 12MB per file.',
          error_code: 'FILE_TOO_LARGE',
          details: {
            max_size: '12MB',
            field: error.field || 'file'
          }
        });

      case 'LIMIT_FILE_COUNT':
        return res.status(400).json({
          success: false,
          message: 'Too many files. Maximum 2 files allowed.',
          error_code: 'TOO_MANY_FILES',
          details: {
            max_files: 2,
            field: error.field
          }
        });

      case 'LIMIT_UNEXPECTED_FILE':
        return res.status(400).json({
          success: false,
          message: `Unexpected file field: ${error.field}. Only address_proof_image and id_proof_image are allowed.`,
          error_code: 'UNEXPECTED_FILE_FIELD',
          details: {
            unexpected_field: error.field,
            allowed_fields: ['address_proof_image', 'id_proof_image']
          }
        });

      case 'LIMIT_PART_COUNT':
        return res.status(400).json({
          success: false,
          message: 'Too many parts in multipart form.',
          error_code: 'TOO_MANY_PARTS'
        });

      case 'LIMIT_FIELD_KEY':
        return res.status(400).json({
          success: false,
          message: 'Field name too long.',
          error_code: 'FIELD_NAME_TOO_LONG'
        });

      case 'LIMIT_FIELD_VALUE':
        return res.status(400).json({
          success: false,
          message: 'Field value too long.',
          error_code: 'FIELD_VALUE_TOO_LONG'
        });

      case 'LIMIT_FIELD_COUNT':
        return res.status(400).json({
          success: false,
          message: 'Too many fields in form.',
          error_code: 'TOO_MANY_FIELDS'
        });

      default:
        return res.status(400).json({
          success: false,
          message: 'File upload error occurred.',
          error_code: 'UPLOAD_ERROR',
          details: {
            multer_error: error.code
          }
        });
    }
  }

  // Handle custom file validation errors from our enhanced fileFilter
  if (error.code === 'INVALID_FILE_TYPE') {
    return res.status(400).json({
      success: false,
      message: error.message,
      error_code: 'INVALID_FILE_TYPE',
      details: {
        field: error.field,
        filename: error.filename,
        allowed_types: ['JPEG', 'PNG', 'GIF', 'WebP', 'BMP', 'TIFF', 'PDF']
      }
    });
  }

  if (error.code === 'INVALID_FILE_EXTENSION') {
    return res.status(400).json({
      success: false,
      message: error.message,
      error_code: 'INVALID_FILE_EXTENSION',
      details: {
        field: error.field,
        filename: error.filename,
        allowed_extensions: ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff', '.tif', '.pdf']
      }
    });
  }

  if (error.code === 'INVALID_FILENAME') {
    return res.status(400).json({
      success: false,
      message: error.message,
      error_code: 'INVALID_FILENAME',
      details: {
        field: error.field,
        filename: error.filename,
        reason: 'Filename contains invalid characters (.. / \\)'
      }
    });
  }

  if (error.code === 'FILE_VALIDATION_ERROR') {
    return res.status(400).json({
      success: false,
      message: 'File validation failed. Please ensure you are uploading valid image or PDF files.',
      error_code: 'FILE_VALIDATION_ERROR',
      details: {
        field: error.field,
        filename: error.filename,
        original_error: error.message
      }
    });
  }

  // Handle other file-related errors
  if (error.message && error.message.toLowerCase().includes('file')) {
    return res.status(400).json({
      success: false,
      message: 'File processing error. Please check your files and try again.',
      error_code: 'FILE_PROCESSING_ERROR',
      details: {
        error_message: error.message
      }
    });
  }

  // If it's not a file upload error, pass it to the next error handler
  next(error);
};

module.exports = { handleFileUploadErrors };
