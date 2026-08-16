// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { App, type Readiness } from './app.js';

describe('application shell', () => {
  it('renders dependency degradation without exposing dependency details', async () => {
    const readiness: Readiness = {
      status: 'degraded',
      database: { status: 'ok' },
      github: { status: 'unconfigured' },
      model: { status: 'unconfigured' },
    };
    render(<App loadReadiness={() => Promise.resolve(readiness)} />);

    expect(screen.getByRole('heading', { name: 'Team Wiki' })).toBeInTheDocument();
    expect(await screen.findByText('部分能力未配置')).toBeInTheDocument();
    expect(screen.queryByText(/postgres:\/\//i)).not.toBeInTheDocument();
  });
});
