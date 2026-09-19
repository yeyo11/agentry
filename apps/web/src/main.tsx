import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { App } from './App';
import { TooltipProvider } from './components/controls';
import { ConfirmProvider } from './components/Dialog';
import { ToastProvider } from './components/Toast';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './lib/theme'; // applies the stored theme before the first paint
import './styles.css';
import './controls.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 1000 },
  },
});

// A data router (rather than <BrowserRouter>) is what makes useBlocker available, which the
// unsaved-changes guard needs to intercept sidebar navigation. App keeps its own <Routes>.
const router = createBrowserRouter([
  {
    path: '*',
    element: (
      <TooltipProvider>
        <ToastProvider>
          <ConfirmProvider>
            <App />
          </ConfirmProvider>
        </ToastProvider>
      </TooltipProvider>
    ),
  },
]);

const root = document.getElementById('root');
if (!root) throw new Error('#root element not found');

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
