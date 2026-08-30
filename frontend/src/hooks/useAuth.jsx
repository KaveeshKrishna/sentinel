import { createContext, useContext, useState, useEffect } from 'react';

export const AuthContext = createContext(null);

export function useAuth() {
  return useContext(AuthContext);
}

export async function apiLogin(username, password) {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Login failed');
  return data;
}

export async function apiLogout() {
  await fetch('/api/auth/logout', { method: 'POST' });
}

export async function checkAuth() {
  const res  = await fetch('/api/auth/check');
  const data = await res.json();
  return data;
}
