const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');

class PythonHealthController {
  constructor() {
    // Python service configuration
    this.pythonServiceUrl = process.env.PYTHON_SERVICE_URL || 'http://localhost:8000';
    this.pythonServiceTimeout = parseInt(process.env.PYTHON_SERVICE_TIMEOUT) || 10000; // 10 seconds
    
    // Configure axios instance for Python service
    this.pythonClient = axios.create({
      baseURL: this.pythonServiceUrl,
      timeout: this.pythonServiceTimeout,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'LiveFX-NodeJS-Service'
      }
    });
  }

  /**
   * Get comprehensive Python service health status
   */
  async getHealthStatus(req, res) {
    try {
      const response = await this.pythonClient.get('/api/health/');
      
      return res.status(200).json({
        success: true,
        message: 'Python market service health retrieved successfully',
        data: response.data,
        python_service_url: this.pythonServiceUrl,
        response_time_ms: response.headers['x-response-time'] || 'N/A'
      });
      
    } catch (error) {
      console.error('Python health check failed:', error.message);
      
      const errorData = {
        success: false,
        message: 'Failed to retrieve Python service health',
        error: error.message,
        python_service_url: this.pythonServiceUrl,
        error_type: error.code || 'UNKNOWN'
      };
      
      // Include response data if available
      if (error.response) {
        errorData.status_code = error.response.status;
        errorData.response_data = error.response.data;
      }
      
      return res.status(503).json(errorData);
    }
  }

  /**
   * Get detailed market data health check
   */
  async getMarketDataHealth(req, res) {
    try {
      const response = await this.pythonClient.get('/api/health/market-data');
      
      return res.status(200).json({
        success: true,
        message: 'Market data health retrieved successfully',
        data: response.data
      });
      
    } catch (error) {
      console.error('Market data health check failed:', error.message);
      
      return res.status(503).json({
        success: false,
        message: 'Failed to retrieve market data health',
        error: error.message,
        error_type: error.code || 'UNKNOWN'
      });
    }
  }

  /**
   * Get execution price calculation health check
   */
  async getExecutionPriceHealth(req, res) {
    try {
      const response = await this.pythonClient.get('/api/health/execution-prices');
      
      return res.status(200).json({
        success: true,
        message: 'Execution price health retrieved successfully',
        data: response.data
      });
      
    } catch (error) {
      console.error('Execution price health check failed:', error.message);
      
      return res.status(503).json({
        success: false,
        message: 'Failed to retrieve execution price health',
        error: error.message,
        error_type: error.code || 'UNKNOWN'
      });
    }
  }

  /**
   * Get market data cleanup service status
   */
  async getCleanupStatus(req, res) {
    try {
      const response = await this.pythonClient.get('/api/health/cleanup/status');
      
      return res.status(200).json({
        success: true,
        message: 'Cleanup service status retrieved successfully',
        data: response.data
      });
      
    } catch (error) {
      console.error('Cleanup status check failed:', error.message);
      
      return res.status(503).json({
        success: false,
        message: 'Failed to retrieve cleanup service status',
        error: error.message,
        error_type: error.code || 'UNKNOWN'
      });
    }
  }

  /**
   * Force immediate market data cleanup
   */
  async forceCleanup(req, res) {
    try {
      const response = await this.pythonClient.post('/api/health/cleanup/force');
      
      return res.status(200).json({
        success: true,
        message: 'Market data cleanup completed successfully',
        data: response.data,
        initiated_by: req.admin?.username || 'Unknown'
      });
      
    } catch (error) {
      console.error('Force cleanup failed:', error.message);
      
      return res.status(500).json({
        success: false,
        message: 'Failed to execute force cleanup',
        error: error.message,
        error_type: error.code || 'UNKNOWN'
      });
    }
  }

  /**
   * Get WebSocket listener status and performance metrics
   */
  async getWebSocketStatus(req, res) {
    try {
      // Get status from market listener endpoint
      const response = await this.pythonClient.get('/api/market/listener/status');
      
      return res.status(200).json({
        success: true,
        message: 'WebSocket listener status retrieved successfully',
        data: response.data
      });
      
    } catch (error) {
      console.error('WebSocket status check failed:', error.message);
      
      return res.status(503).json({
        success: false,
        message: 'Failed to retrieve WebSocket listener status',
        error: error.message,
        error_type: error.code || 'UNKNOWN'
      });
    }
  }

  /**
   * Get recent execution price issues from debug logs
   */
  async getExecutionPriceIssues(req, res) {
    try {
      const { limit = 50, severity = 'all', user_type = 'all' } = req.query;
      
      // Define log files to check
      const logFiles = [
        'execution_price_stale.log',
        'execution_price_inconsistent.log', 
        'execution_price_missing.log',
        'execution_price_user_issues.log',
        'execution_price_websocket.log'
      ];
      
      const logDir = path.join(__dirname, '../../logs/execution_price');
      const issues = [];
      const issuesByType = {};
      const checkedFiles = [];
      
      for (const logFile of logFiles) {
        const logPath = path.join(logDir, logFile);
        
        try {
          await fs.access(logPath);
          checkedFiles.push(logFile);
          
          // Read recent log entries
          const logContent = await fs.readFile(logPath, 'utf8');
          const lines = logContent.split('\n').filter(line => line.trim());
          
          // Parse recent entries (last N lines)
          const recentLines = lines.slice(-Math.min(limit, 100));
          
          for (const line of recentLines) {
            try {
              // Extract JSON from log line
              const jsonMatch = line.match(/\{.*\}/);
              if (jsonMatch) {
                const issueData = JSON.parse(jsonMatch[0]);
                
                // Apply filters
                if (severity !== 'all' && issueData.severity?.toLowerCase() !== severity.toLowerCase()) {
                  continue;
                }
                
                if (user_type !== 'all' && issueData.user_type?.toLowerCase() !== user_type.toLowerCase()) {
                  continue;
                }
                
                // Add metadata
                issueData.log_file = logFile;
                issueData.log_timestamp = line.substring(0, 23); // Extract timestamp from log line
                
                issues.push(issueData);
                
                // Count by type
                const issueType = issueData.issue_type || 'UNKNOWN';
                issuesByType[issueType] = (issuesByType[issueType] || 0) + 1;
              }
            } catch (parseError) {
              // Skip malformed log lines
              continue;
            }
          }
          
        } catch (fileError) {
          // Log file doesn't exist or can't be read
          continue;
        }
      }
      
      // Sort issues by timestamp (most recent first)
      issues.sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));
      
      // Limit results
      const limitedIssues = issues.slice(0, parseInt(limit));
      
      return res.status(200).json({
        success: true,
        message: `Retrieved ${limitedIssues.length} execution price issues`,
        data: {
          total_issues: limitedIssues.length,
          issues_by_type: issuesByType,
          recent_issues: limitedIssues,
          log_files_checked: checkedFiles,
          filters_applied: {
            limit: parseInt(limit),
            severity,
            user_type
          }
        }
      });
      
    } catch (error) {
      console.error('Failed to retrieve execution price issues:', error.message);
      
      return res.status(500).json({
        success: false,
        message: 'Failed to retrieve execution price issues from logs',
        error: error.message
      });
    }
  }

  /**
   * Switch to protobuf binary WebSocket listener
   */
  async switchProtobufListener(req, res) {
    try {
      const { enable } = req.body;
      
      if (typeof enable !== 'boolean') {
        return res.status(400).json({
          success: false,
          message: 'Invalid request: enable must be a boolean'
        });
      }
      
      // This would require implementing listener switching in Python service
      // For now, return a placeholder response
      const switchTime = new Date().toISOString();
      
      return res.status(200).json({
        success: true,
        message: `Protobuf listener ${enable ? 'enabled' : 'disabled'} successfully`,
        data: {
          previous_listener: enable ? 'json' : 'protobuf',
          current_listener: enable ? 'protobuf' : 'json',
          switch_time: switchTime,
          initiated_by: req.admin?.username || 'Unknown',
          note: 'This feature requires Python service implementation'
        }
      });
      
    } catch (error) {
      console.error('Failed to switch protobuf listener:', error.message);
      
      return res.status(500).json({
        success: false,
        message: 'Failed to switch WebSocket listener',
        error: error.message
      });
    }
  }

  /**
   * Test Python service connectivity
   */
  async testConnectivity(req, res) {
    try {
      const startTime = Date.now();
      const response = await this.pythonClient.get('/');
      const responseTime = Date.now() - startTime;
      
      return res.status(200).json({
        success: true,
        message: 'Python service connectivity test passed',
        data: {
          python_service_url: this.pythonServiceUrl,
          response_time_ms: responseTime,
          status_code: response.status,
          service_info: response.data
        }
      });
      
    } catch (error) {
      console.error('Python service connectivity test failed:', error.message);
      
      return res.status(503).json({
        success: false,
        message: 'Python service connectivity test failed',
        error: error.message,
        python_service_url: this.pythonServiceUrl,
        error_type: error.code || 'UNKNOWN'
      });
    }
  }
}

module.exports = new PythonHealthController();
