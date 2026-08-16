import { useEffect, useState } from 'react';

export interface DependencyStatus {
  readonly status: 'ok' | 'degraded' | 'unavailable' | 'disabled' | 'unconfigured';
  readonly error_code?: string;
}

export interface Readiness {
  readonly status: 'ready' | 'degraded';
  readonly database: DependencyStatus;
  readonly github: DependencyStatus;
  readonly model: DependencyStatus;
}

type ViewState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'loaded'; readonly readiness: Readiness }
  | { readonly kind: 'unavailable' };

async function fetchReadiness(): Promise<Readiness> {
  const response = await fetch('/health/ready', {
    headers: { Accept: 'application/json' },
    credentials: 'same-origin',
  });
  if (!response.ok) {
    throw new Error('Readiness unavailable');
  }
  return (await response.json()) as Readiness;
}

function statusLabel(state: ViewState): string {
  if (state.kind === 'loading') return '正在检查依赖';
  if (state.kind === 'unavailable') return '暂时无法获取系统状态';
  return state.readiness.status === 'ready' ? '系统已就绪' : '部分能力未配置';
}

export function App({
  loadReadiness = fetchReadiness,
}: {
  readonly loadReadiness?: () => Promise<Readiness>;
}) {
  const [state, setState] = useState<ViewState>({ kind: 'loading' });

  useEffect(() => {
    let active = true;
    void loadReadiness()
      .then((readiness) => {
        if (active) setState({ kind: 'loaded', readiness });
      })
      .catch(() => {
        if (active) setState({ kind: 'unavailable' });
      });
    return () => {
      active = false;
    };
  }, [loadReadiness]);

  return (
    <main className="shell">
      <section className="hero" aria-labelledby="page-title">
        <p className="eyebrow">内部知识工作台</p>
        <h1 id="page-title">Team Wiki</h1>
        <p className="lede">应用骨架已启动。登录、草稿与发布能力将在后续迭代中按模块接入。</p>
        <div className={`status status--${state.kind}`} role="status" aria-live="polite">
          <span className="status__dot" aria-hidden="true" />
          {statusLabel(state)}
        </div>
      </section>
    </main>
  );
}
