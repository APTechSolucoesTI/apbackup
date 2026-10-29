import { AlertCircle, Inbox, LoaderCircle, LockKeyhole, SearchX } from 'lucide-react';
import { Button } from '@/components/ui/button';
export function DataState({
  state,
  title,
  description,
  onRetry,
  onClear,
}: {
  state: 'loading' | 'empty' | 'no-results' | 'error' | 'forbidden' | 'missing';
  title?: string;
  description?: string;
  onRetry?: () => void;
  onClear?: () => void;
}) {
  const config = {
    loading: {
      icon: LoaderCircle,
      title: 'Carregando dados',
      description: 'Aguarde enquanto consultamos o catálogo.',
    },
    empty: {
      icon: Inbox,
      title: 'Ainda não há registros',
      description: 'Os registros aparecerão aqui após o cadastro.',
    },
    'no-results': {
      icon: SearchX,
      title: 'Nenhum resultado para os filtros',
      description: 'Ajuste a busca ou limpe os filtros para ver todos os registros.',
    },
    error: {
      icon: AlertCircle,
      title: 'Não foi possível carregar os dados',
      description: 'Confira sua conexão e tente novamente.',
    },
    forbidden: {
      icon: LockKeyhole,
      title: 'Acesso restrito',
      description: 'Sua conta não tem permissão para acessar este conteúdo.',
    },
    missing: {
      icon: SearchX,
      title: 'Registro não encontrado',
      description: 'O registro pode ter sido removido ou não estar disponível.',
    },
  }[state];
  const Icon = config.icon;
  return (
    <div className="data-state" role={state === 'error' ? 'alert' : 'status'}>
      <span className="state-icon">
        <Icon aria-hidden="true" className={state === 'loading' ? 'animate-spin' : ''} />
      </span>
      <h2>{title ?? config.title}</h2>
      <p>{description ?? config.description}</p>
      {onRetry && (
        <Button variant="outline" onClick={onRetry}>
          Tentar novamente
        </Button>
      )}
      {onClear && (
        <Button variant="outline" onClick={onClear}>
          Limpar filtros
        </Button>
      )}
    </div>
  );
}
