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

const upload = multer({ 
  storage,
  limits: {
    fileSize: 12 * 1024 * 1024, // 12MB per individual file
    files: 2, // Maximum 2 files
    fieldSize: 1024 * 1024, // 1MB per field value
    fieldNameSize: 100, // 100 bytes per field name
    fields: 20 // Maximum 20 non-file fields
  },
  fileFilter: (req, file, cb) => {
    // Accept only image files
    const allowedMimes = [
      'image/jpeg',
      'image/jpg', 
      'image/png',
      'image/gif',
      'image/webp',
      'image/bmp',
      'image/tiff'
    ];
    
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Invalid file type: ${file.mimetype}. Only image files are allowed.`), false);
    }
  }
});

module.exports = upload; 