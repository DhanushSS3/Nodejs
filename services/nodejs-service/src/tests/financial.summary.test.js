const request = require('supertest');
const app = require('../app');
const FinancialSummaryService = require('../services/financial.summary.service');

// Mock the service to avoid database dependencies in tests
jest.mock('../services/financial.summary.service');

describe('Financial Summary API', () => {
  const mockJWT = 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjMiLCJ1c2VyX2lkIjoxMjMsImFjY291bnRfdHlwZSI6ImxpdmUiLCJpYXQiOjE2MzQ1NjcwMDB9.mock';
  
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /api/financial-summary', () => {
    it('should return financial summary for authenticated user', async () => {
      const mockSummary = {
        user_id: 123,
        user_type: 'live',
        balance: 10000.50,
        total_margin: 2500.00,
        period: {
          start_date: null,
          end_date: null,
          is_filtered: false
        },
        trading: {
          net_profit: 1250.75,
          commission: 45.50,
          swap: -12.25,
          total_orders: 25
        },
        transactions: {
          total_deposits: 5000.00,
          deposit_count: 3
        },
        overall: {
          user_net_profit: 1250.75
        }
      };

      FinancialSummaryService.getFinancialSummary.mockResolvedValue(mockSummary);

      const response = await request(app)
        .get('/api/financial-summary')
        .set('Authorization', mockJWT)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.message).toBe('Financial summary retrieved successfully');
      expect(response.body.data).toEqual(mockSummary);
    });

    it('should return financial summary with date filtering', async () => {
      const mockSummary = {
        user_id: 123,
        user_type: 'live',
        balance: 10000.50,
        total_margin: 2500.00,
        period: {
          start_date: '2024-01-01T00:00:00.000Z',
          end_date: '2024-12-31T23:59:59.999Z',
          is_filtered: true
        },
        trading: {
          net_profit: 500.25,
          commission: 20.00,
          swap: -5.00,
          total_orders: 10
        },
        transactions: {
          total_deposits: 2000.00,
          deposit_count: 1
        },
        overall: {
          user_net_profit: 1250.75
        }
      };

      FinancialSummaryService.getFinancialSummary.mockResolvedValue(mockSummary);

      const response = await request(app)
        .get('/api/financial-summary?start_date=2024-01-01&end_date=2024-12-31')
        .set('Authorization', mockJWT)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.period.is_filtered).toBe(true);
    });

    it('should return 400 for invalid date format', async () => {
      const response = await request(app)
        .get('/api/financial-summary?start_date=invalid-date')
        .set('Authorization', mockJWT)
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.message).toContain('start_date must be a valid date');
    });

    it('should return 401 for missing authorization', async () => {
      const response = await request(app)
        .get('/api/financial-summary')
        .expect(401);

      expect(response.body.success).toBe(false);
    });
  });

  describe('GET /api/live-users/financial-summary', () => {
    it('should return financial summary for live user', async () => {
      const mockSummary = {
        user_id: 123,
        user_type: 'live',
        balance: 10000.50,
        total_margin: 2500.00,
        period: {
          start_date: null,
          end_date: null,
          is_filtered: false
        },
        trading: {
          net_profit: 1250.75,
          commission: 45.50,
          swap: -12.25,
          total_orders: 25
        },
        transactions: {
          total_deposits: 5000.00,
          deposit_count: 3
        },
        overall: {
          user_net_profit: 1250.75
        }
      };

      FinancialSummaryService.getFinancialSummary.mockResolvedValue(mockSummary);

      const response = await request(app)
        .get('/api/live-users/financial-summary')
        .set('Authorization', mockJWT)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.user_type).toBe('live');
    });
  });

  describe('GET /api/demo-users/financial-summary', () => {
    it('should return financial summary for demo user', async () => {
      const mockSummary = {
        user_id: 456,
        user_type: 'demo',
        balance: 50000.00,
        total_margin: 1000.00,
        period: {
          start_date: null,
          end_date: null,
          is_filtered: false
        },
        trading: {
          net_profit: 750.50,
          commission: 25.00,
          swap: -8.00,
          total_orders: 15
        },
        transactions: {
          total_deposits: 0.00,
          deposit_count: 0
        },
        overall: {
          user_net_profit: 750.50
        }
      };

      FinancialSummaryService.getFinancialSummary.mockResolvedValue(mockSummary);

      const response = await request(app)
        .get('/api/demo-users/financial-summary')
        .set('Authorization', mockJWT)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.user_type).toBe('demo');
    });
  });
});

describe('FinancialSummaryService', () => {
  describe('validateDateRange', () => {
    it('should validate correct date formats', () => {
      const result = FinancialSummaryService.validateDateRange('2024-01-01', '2024-12-31');
      expect(result.startDate).toBeInstanceOf(Date);
      expect(result.endDate).toBeInstanceOf(Date);
    });

    it('should throw error for invalid start date', () => {
      expect(() => {
        FinancialSummaryService.validateDateRange('invalid-date', '2024-12-31');
      }).toThrow('Invalid start_date format');
    });

    it('should throw error for invalid end date', () => {
      expect(() => {
        FinancialSummaryService.validateDateRange('2024-01-01', 'invalid-date');
      }).toThrow('Invalid end_date format');
    });

    it('should throw error when start date is greater than end date', () => {
      expect(() => {
        FinancialSummaryService.validateDateRange('2024-12-31', '2024-01-01');
      }).toThrow('start_date cannot be greater than end_date');
    });

    it('should handle null dates', () => {
      const result = FinancialSummaryService.validateDateRange(null, null);
      expect(result.startDate).toBeNull();
      expect(result.endDate).toBeNull();
    });
  });
});
