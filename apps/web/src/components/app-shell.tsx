import { Link, useRouterState } from '@tanstack/react-router';
import { useEffect, useState, type ReactNode } from 'react';
import {
  Activity,
  Archive,
  Boxes,
  CircleHelp,
  Database,
  HardDrive,
  LayoutDashboard,
  LogOut,
  Menu,
  Moon,
  Server,
  Settings,
  ShieldCheck,
  Sun,
  Workflow,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetTrigger,
  SheetDescription,
} from '@/components/ui/sheet';
import type { ConsoleSession } from '@/lib/client-api';
import { api, resultSchema } from '@/lib/client-api';
import { humanLabel, listQuerySchema } from '@/lib/listing';
const navigation = [
  { to: '/', label: 'Cobertura', icon: LayoutDashboard },
  { to: '/servers', label: 'Servidores', icon: Server },
  { to: '/systems', label: 'Sistemas', icon: Boxes },
  { to: '/resources', label: 'Recursos', icon: Database },
  { to: '/destinations', label: 'Destinos', icon: HardDrive },
  { to: '/plans', label: 'Planos', icon: Workflow },
  { to: '/executions', label: 'Execuções', icon: Activity },
] as const;
export function Brand() {
  return (
    <span className="brand">
      <span className="brand-symbol">
        <Archive aria-hidden="true" />
      </span>
      <span>
        AP<span className="font-normal">Backup</span>
        <small>BACKUP & RECUPERAÇÃO</small>
      </span>
    </span>
  );
}
export function ThemeToggle() {
  const [dark, setDark] = useState(false);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setDark(document.documentElement.classList.contains('dark'));
    setReady(true);
  }, []);
  return (
    <Button
      variant="ghost"
      size="icon"
      disabled={!ready}
      aria-label={dark ? 'Usar tema claro' : 'Usar tema escuro'}
      onClick={() => {
        document.documentElement.classList.toggle('dark', !dark);
        try {
          localStorage.setItem('apbackup:theme', dark ? 'light' : 'dark');
        } catch {
          /* Theme remains usable without browser storage. */
        }
        setDark(!dark);
      }}
    >
      {dark ? <Sun /> : <Moon />}
    </Button>
  );
}
export function AppShell({ session, children }: { session: ConsoleSession; children: ReactNode }) {
  const [open, setOpen] = useState(false),
    [leaving, setLeaving] = useState(false);
  const path = useRouterState({ select: (s) => s.location.pathname });
  const href = useRouterState({ select: (s) => s.location.href });
  const [pageSizes, setPageSizes] = useState<Record<string, number>>({});
  useEffect(() => {
    const sizes: Record<string, number> = {};
    for (const item of navigation) {
      const key = item.to === '/' ? 'coverage' : item.to.slice(1);
      try {
        const raw: unknown = JSON.parse(
          localStorage.getItem(
            `apbackup:columns:${session.userId}:${session.organizationId}:${key}`,
          ) ?? 'null',
        );
        if (raw && typeof raw === 'object' && 'pageSize' in raw) {
          const parsed = listQuerySchema.shape.pageSize.safeParse(raw.pageSize);
          if (parsed.success) sizes[item.to] = parsed.data;
        }
      } catch {
        /* Navigation uses the default if browser preferences are unavailable. */
      }
    }
    setPageSizes(sizes);
  }, [href, session.userId, session.organizationId]);
  const nav = (
    <>
      <Link
        to="/"
        search={{}}
        className="brand-link"
        onClick={() => setOpen(false)}
        aria-label="APBackup, cobertura"
      >
        <Brand />
      </Link>
      <div className="nav-caption">OPERAÇÃO</div>
      <nav aria-label="Navegação principal">
        <Link
          to="/dokploy"
          className={path === '/dokploy' ? 'nav-link selected' : 'nav-link'}
          aria-current={path === '/dokploy' ? 'page' : undefined}
          onClick={() => setOpen(false)}
        >
          <Boxes aria-hidden="true" />
          Dokploy
        </Link>
        <Link
          to="/docker"
          className={path === '/docker' ? 'nav-link selected' : 'nav-link'}
          aria-current={path === '/docker' ? 'page' : undefined}
          onClick={() => setOpen(false)}
        >
          <Database aria-hidden="true" />
          Docker e arquivos
        </Link>
        <Link
          to="/postgresql"
          className={path === '/postgresql' ? 'nav-link selected' : 'nav-link'}
          aria-current={path === '/postgresql' ? 'page' : undefined}
          onClick={() => setOpen(false)}
        >
          <Database aria-hidden="true" />
          PostgreSQL
        </Link>
        {navigation.map(({ to, label, icon: Icon }) => (
          <Link
            key={to}
            to={to === '/' ? '/' : '/$section'}
            params={{ section: to.slice(1) }}
            search={{ pageSize: pageSizes[to] ?? 10 }}
            className={path === to ? 'nav-link selected' : 'nav-link'}
            aria-current={path === to ? 'page' : undefined}
            onClick={() => setOpen(false)}
          >
            <Icon aria-hidden="true" />
            {label}
          </Link>
        ))}
      </nav>
      <div className="sidebar-bottom">
        <Link
          to="/settings"
          className={path === '/settings' ? 'nav-link selected' : 'nav-link'}
          onClick={() => setOpen(false)}
        >
          <Settings aria-hidden="true" />
          Configurações
        </Link>
        <Link
          to="/security"
          className={path === '/security' ? 'nav-link selected' : 'nav-link'}
          onClick={() => setOpen(false)}
        >
          <ShieldCheck aria-hidden="true" />
          Segurança da conta
        </Link>
        <div className="sidebar-note">
          <CircleHelp aria-hidden="true" />
          <p>
            Evidência antes de confiança.
            <br />
            <span>Um backup só protege quando pode ser recuperado.</span>
          </p>
        </div>
      </div>
    </>
  );
  return (
    <div className="app-layout">
      <a href="#main-content" className="skip-link">
        Pular para o conteúdo
      </a>
      <aside className="sidebar">{nav}</aside>
      <div className="workspace">
        <header className="topbar">
          <div className="topbar-context">
            <Sheet open={open} onOpenChange={setOpen}>
              <SheetTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="mobile-menu"
                  aria-label="Abrir navegação"
                >
                  <Menu />
                </Button>
              </SheetTrigger>
              <SheetContent side="left" className="mobile-sidebar">
                <SheetTitle className="sr-only">Navegação do APBackup</SheetTitle>
                <SheetDescription className="sr-only">
                  Módulos de operação e segurança da conta.
                </SheetDescription>
                {nav}
              </SheetContent>
            </Sheet>
            <span className="organization-dot" aria-hidden="true" />
            <span className="organization-name">{session.organization}</span>
          </div>
          <div className="topbar-actions">
            <ThemeToggle />
            <div className="account-summary">
              <strong>{session.name}</strong>
              <span>{humanLabel(session.role)}</span>
            </div>
            <Button
              variant="ghost"
              disabled={leaving}
              onClick={async () => {
                setLeaving(true);
                try {
                  await api('/api/auth/sign-out', resultSchema, {});
                  window.location.assign('/login');
                } catch {
                  toast.error('Não foi possível sair. Tente novamente.');
                  setLeaving(false);
                }
              }}
            >
              <LogOut aria-hidden="true" />
              <span>{leaving ? 'Saindo…' : 'Sair'}</span>
            </Button>
          </div>
        </header>
        <main id="main-content" tabIndex={-1} className="main-content">
          {children}
        </main>
        <footer className="workspace-footer">
          <span>APBackup · Catálogo operacional</span>
          <span>Horários em America/Sao_Paulo</span>
        </footer>
      </div>
    </div>
  );
}
