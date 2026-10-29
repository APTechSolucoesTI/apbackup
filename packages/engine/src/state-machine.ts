import type { ExecutionStatus } from '@apbackup/contracts';
const transitions: Record<ExecutionStatus, readonly ExecutionStatus[]> = {
  aguardando: ['verificando', 'cancelada', 'exige_intervencao', 'falhou'],
  verificando: ['capturando', 'cancelada', 'falhou', 'exige_intervencao'],
  capturando: ['enviando', 'cancelada', 'falhou', 'exige_intervencao'],
  enviando: ['verificando_destino', 'falhas_parciais', 'falhou', 'cancelada', 'exige_intervencao'],
  verificando_destino: ['concluida', 'falhas_parciais', 'falhou', 'exige_intervencao'],
  concluida: [],
  falhas_parciais: [],
  falhou: [],
  cancelada: [],
  exige_intervencao: [],
};
export function assertTransition(
  from: ExecutionStatus,
  to: ExecutionStatus,
  kind: 'backup' | 'restore' = 'backup',
) {
  if (kind === 'restore' && from === 'verificando' && to === 'concluida') return;
  if (from !== to && !transitions[from].includes(to))
    throw new Error('Invalid execution transition');
}
