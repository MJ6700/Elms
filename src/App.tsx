/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect } from 'react';
import { WifiOff } from 'lucide-react';

export default function App() {
  const [isOnline, setIsOnline] = useState(
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );
  const [offlineHtml, setOfflineHtml] = useState<string | null>(null);

  // Perpetual Session Keep-Alive and Offline Management
  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    // Load any existing cached offline HTML from storage
    try {
      const saved = localStorage.getItem('sti_offline_html');
      if (saved) setOfflineHtml(saved);
    } catch {
      // Storage access error
    }

    // Pre-cache the latest HTML for offline use
    const refreshCache = () => {
      if (navigator.onLine) {
        fetch('/api/proxy?url=https%3A%2F%2Felms.sti.edu%2F', { credentials: 'include' })
          .then((res) => (res.ok ? res.text() : null))
          .then((html) => {
            if (html) {
              setOfflineHtml(html);
              try {
                localStorage.setItem('sti_offline_html', html);
              } catch {
                // Storage full or unavailable
              }
            }
          })
          .catch(() => {});
      }
    };

    refreshCache();

    // Perpetual Keep-Alive Heartbeat: pings every 2.5 minutes to prevent idle logout
    const heartbeatInterval = setInterval(() => {
      if (navigator.onLine) {
        fetch('/api/session-keepalive', { credentials: 'include' }).catch(() => {});
        refreshCache();
      }
    }, 150000); // 2.5 minutes

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      clearInterval(heartbeatInterval);
    };
  }, []);

  return (
    <div className="relative w-screen h-screen overflow-hidden bg-white">
      {/* 144Hz Fullscreen STI eLMS iframe with Perpetual Session */}
      <iframe
        src={isOnline ? '/api/proxy?url=https%3A%2F%2Felms.sti.edu%2F' : undefined}
        srcDoc={!isOnline && offlineHtml ? offlineHtml : undefined}
        title="STI eLMS"
        loading="eager"
        className="fixed inset-0 w-full h-full border-0 m-0 p-0 block bg-white"
        style={{
          transform: 'translateZ(0)',
          backfaceVisibility: 'hidden',
          willChange: 'transform',
          contain: 'strict',
        }}
        allow="fullscreen; clipboard-read; clipboard-write; autoplay; camera; microphone"
      />

      {/* Non-intrusive Offline Indicator Banner */}
      {!isOnline && (
        <div className="fixed bottom-4 left-4 z-50 flex items-center gap-2 rounded-lg bg-[#002D5A] border border-[#FFC72C]/60 px-3 py-1.5 text-xs font-medium text-white shadow-xl pointer-events-none animate-in fade-in duration-200">
          <WifiOff className="w-3.5 h-3.5 text-[#FFC72C] animate-pulse" />
          <span>Offline Mode — Cached STI eLMS data active</span>
        </div>
      )}
    </div>
  );
}
