import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode, useEffect, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router';
import { Account } from './pages/Account';
import { Admin } from './pages/Admin';
import { Forgot, Invite, Login, Reset, Signup, Verify } from './pages/Auth';
import { Drivers } from './pages/Drivers';
import { Home } from './pages/Home';
import { Privacy, Terms } from './pages/Legal';
import { OrgLayout } from './pages/OrgLayout';
import { Orgs } from './pages/Orgs';
import { Profile } from './pages/Profile';
import { Settings } from './pages/Settings';
import { Features, Guide, Landing } from './pages/Site';
import { Transport } from './pages/Transport';
import { TransportNew } from './pages/TransportNew';
import { Spinner } from './components/ui';
import { counterLoaded, isPublicPath } from './lib/analytics';
import './lib/theme';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: true, staleTime: 5_000 } },
});

// Needed for push notifications; harmless where they are not supported.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => undefined);
}

/** The front door: visitors get the public home page, people who are logged in get their rescues. */
/**
 * A visitor who was counted on a public page and now heads for the log-in pages or the app gets
 * a fresh page load, so the counter's script is gone before they type anything. See lib/analytics.
 */
function LeaveCounterBehind({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const leaving = counterLoaded() && !isPublicPath(pathname);
  useEffect(() => {
    if (leaving) window.location.reload();
  }, [leaving]);
  return leaving ? <Spinner /> : children;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <LeaveCounterBehind>
        <Routes>
          {/* The home page is the same for everyone; the app itself starts at /app. */}
          <Route path="/" element={<Landing />} />
          <Route path="/app" element={<Orgs />} />
          <Route path="/about" element={<Navigate to="/" replace />} />
          <Route path="/features" element={<Features />} />
          <Route path="/how-it-works" element={<Guide />} />
          <Route path="/login" element={<Login />} />
          <Route path="/signup" element={<Signup />} />
          <Route path="/forgot" element={<Forgot />} />
          <Route path="/reset/:token" element={<Reset />} />
          <Route path="/verify/:token" element={<Verify />} />
          <Route path="/invite/:token" element={<Invite />} />
          <Route path="/privacy" element={<Privacy />} />
          <Route path="/terms" element={<Terms />} />
          <Route path="/admin" element={<Admin />} />
          <Route path="/account" element={<Account />} />
          <Route path="/o/:slug" element={<OrgLayout />}>
            <Route index element={<Home />} />
            <Route path="transports/new" element={<TransportNew />} />
            <Route path="transports/:id" element={<Transport />} />
            <Route path="drivers" element={<Drivers />} />
            <Route path="profile" element={<Profile />} />
            <Route path="settings" element={<Settings />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        </LeaveCounterBehind>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
