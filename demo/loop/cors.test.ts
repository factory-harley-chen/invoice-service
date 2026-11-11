import { describe, expect, it } from 'vitest';
import { readHeaders, readOrigin } from './cors.ts';

describe('readOrigin', () => {
  it('lets a deck opened from a file read the state', () => {
    expect(readOrigin('null')).toBe('null');
  });

  it('lets pages served from this machine read the state, on any port', () => {
    expect(readOrigin('http://localhost:8080')).toBe('http://localhost:8080');
    expect(readOrigin('http://127.0.0.1:4200')).toBe('http://127.0.0.1:4200');
    expect(readOrigin('http://localhost')).toBe('http://localhost');
    expect(readOrigin('https://localhost:8443')).toBe('https://localhost:8443');
  });

  it('refuses other sites and look-alikes', () => {
    expect(readOrigin(undefined)).toBeNull();
    expect(readOrigin('https://example.com')).toBeNull();
    expect(readOrigin('http://localhost.example.com')).toBeNull();
    expect(readOrigin('http://127.0.0.1.example.com:4200')).toBeNull();
    expect(readOrigin('http://evil.test/?http://localhost')).toBeNull();
    expect(readOrigin('file://')).toBeNull();
    expect(readOrigin('not a url')).toBeNull();
    expect(readOrigin('')).toBeNull();
  });
});

describe('readHeaders', () => {
  it('echoes an allowed origin on GET, with Vary', () => {
    expect(readHeaders('GET', 'null')).toEqual({ 'Access-Control-Allow-Origin': 'null', Vary: 'Origin' });
    expect(readHeaders('GET', 'http://localhost:5173')).toEqual({ 'Access-Control-Allow-Origin': 'http://localhost:5173', Vary: 'Origin' });
  });

  it('adds nothing for other methods, other sites or no origin', () => {
    expect(readHeaders('POST', 'null')).toEqual({});
    expect(readHeaders('OPTIONS', 'http://localhost:5173')).toEqual({});
    expect(readHeaders('GET', 'https://example.com')).toEqual({});
    expect(readHeaders('GET', undefined)).toEqual({});
  });
});
