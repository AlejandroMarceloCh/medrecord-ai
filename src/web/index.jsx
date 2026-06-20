import React from 'react';
import { createRoot } from 'react-dom/client';
import { WebRoot } from './app.jsx';
import { LoginGate } from './login.jsx';

createRoot(document.getElementById('root')).render(
  <LoginGate><WebRoot/></LoginGate>
);
