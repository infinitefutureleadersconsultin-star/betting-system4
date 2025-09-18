import React from 'react';
import { downloadLogsCSV } from '../utils/analytics';

export default function Header() {
  return (
    <header className="bg-dark-card border-b border-gray-700">
      <div className="container mx-auto px-4 py-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold text-betting-green">Master Betting System</h1>
            <p className="text-gray-400 mt-1">Advanced Analytics for Player Props & Game Lines</p>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={() => downloadLogsCSV()}
              className="px-3 py-2 rounded-md bg-gray-700 hover:bg-gray-600 text-sm"
              title="Export analyzed picks to CSV for calibration"
            >
              Download Logs (CSV)
            </button>

            <div className="text-right">
              <div className="text-sm text-gray-400">System Status</div>
              <div className="flex items-center">
                <div className="w-2 h-2 bg-betting-green rounded-full mr-2"></div>
                <span className="text-betting-green">Online</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}
