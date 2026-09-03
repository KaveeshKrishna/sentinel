import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/index.css';

async function boot() {
  // Public demo build: swap fetch + WebSocket for the in-browser mocks
  // before the app mounts. Guarded so all of src/demo/ is tree-shaken out
  // of the normal build.
  if (import.meta.env.VITE_DEMO) {
    const { installDemo } = await import('./demo/installDemo.js');
    installDemo();
  }

  ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}

boot();
