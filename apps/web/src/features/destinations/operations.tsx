import { useEffect, useId, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { pointDestinationsResultSchema, type optionsResultSchema } from '@apbackup/contracts';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { api } from '@/lib/client-api';
import { humanLabel } from '@/lib/listing';
import { RecordPicker } from '@/features/configuration/record-picker';

type Options = z.infer<typeof optionsResultSchema>['items'];
export function AdditionalDestinations({
  items,
  primary,
  value,
  onChange,
}: {
  items: Options;
  primary: string;
  value: string[];
  onChange: (value: string[]) => void;
}) {
  return (
    <fieldset className="grid gap-2 rounded-lg border p-3">
      <legend className="px-1 text-sm font-medium">Cópias adicionais do mesmo backup</legend>
      <p className="text-xs text-muted-foreground">
        A captura usa o destino local principal. Cada cópia terá sua própria verificação; uma falha
        aparecerá separadamente e poderá ser repetida.
      </p>
      {items
        .filter((item) => item.id !== primary)
        .map((item) => (
          <label key={item.id} className="flex min-h-11 items-center gap-2 text-sm">
            <Checkbox
              checked={value.includes(item.id)}
              onCheckedChange={(checked) =>
                onChange([
                  ...new Set([
                    ...(primary ? [primary] : []),
                    ...(checked ? [...value, item.id] : value.filter((id) => id !== item.id)),
                  ]),
                ])
              }
            />
            <span>
              {item.label} <span className="text-xs text-muted-foreground">{item.detail}</span>
            </span>
          </label>
        ))}
      {items.length <= (primary ? 1 : 0) && (
        <p className="text-sm text-muted-foreground">
          Cadastre outro destino para manter uma cópia fora da origem.
        </p>
      )}
    </fieldset>
  );
}

const executionResult = z.object({ executionId: z.uuid() });
const executionStatus = z.object({ status: z.string() });
const terminal = new Set([
  'concluida',
  'falhas_parciais',
  'falhou',
  'cancelada',
  'exige_intervencao',
]);
function useQueuedOperation() {
  const [executionId, setExecutionId] = useState('');
  const status = useQuery({
    queryKey: ['destination-operation', executionId],
    queryFn: () => api(`/api/runtime/executions/${executionId}`, executionStatus),
    enabled: !!executionId,
    refetchInterval: (query) => (terminal.has(query.state.data?.status ?? '') ? false : 3000),
  });
  const mutation = useMutation({
    mutationFn: ({ path, body }: { path: string; body: Record<string, unknown> }) =>
      api(`/api/runtime/${path}`, executionResult, {
        ...body,
        idempotencyKey: crypto.randomUUID(),
      }),
    onSuccess: (data) => setExecutionId(data.executionId),
  });
  return {
    ...mutation,
    busy: mutation.isPending || (!!executionId && !terminal.has(status.data?.status ?? '')),
    status: status.data?.status,
    executionId,
    statusError: status.error,
  };
}
function OperationFeedback({ operation }: { operation: ReturnType<typeof useQueuedOperation> }) {
  return (
    <div aria-live="polite" className="text-sm">
      {operation.executionId && (
        <p>
          Operação: {humanLabel(operation.status ?? 'aguardando')}. Acompanhe os detalhes em
          Execuções.
        </p>
      )}
      {(operation.error || operation.statusError) && (
        <p role="alert" className="text-destructive">
          {(operation.error ?? operation.statusError)?.message}
        </p>
      )}
    </div>
  );
}

export function DestinationAssessment({
  destinationId,
  cacheScope,
  dirty,
}: {
  destinationId: string;
  cacheScope: string;
  dirty: boolean;
}) {
  const [profileVersionId, setProfileVersionId] = useState('');
  const operation = useQueuedOperation();
  return (
    <section className="grid gap-3 rounded-lg border p-3" aria-label="Avaliação real do destino">
      <h3 className="font-semibold">Avaliar o destino pelo agente</h3>
      <p className="text-sm text-muted-foreground">
        O teste usa a configuração guardada e o agente responsável pelo recurso escolhido. Ele abre
        ou inicializa o repositório e verifica o acesso real. Salve as alterações antes de testar; o
        resultado ficará nas capacidades do destino.
      </p>
      <RecordPicker
        label="Recurso para escolher o agente do teste"
        kind="profiles"
        value={profileVersionId}
        onChange={setProfileVersionId}
        cacheScope={cacheScope}
      />
      <Button
        type="button"
        variant="outline"
        disabled={!profileVersionId || dirty || operation.busy}
        onClick={() =>
          operation.mutate({ path: 'test-destination', body: { destinationId, profileVersionId } })
        }
      >
        {' '}
        {operation.busy ? 'Avaliando…' : 'Testar configuração guardada'}
      </Button>
      {dirty && <p className="text-sm text-muted-foreground">Há alterações sem salvar.</p>}
      <OperationFeedback operation={operation} />
    </section>
  );
}

function usePointDestinations(pointId: string, enabled = true) {
  return useQuery({
    queryKey: ['point-destinations', pointId],
    queryFn: () =>
      api(`/api/runtime/points/${pointId}/destinations`, pointDestinationsResultSchema),
    enabled: enabled && !!pointId,
    refetchInterval: enabled ? 3000 : false,
  });
}
export function PointDestinationStatus({
  pointId,
  canBackup,
  canRetain,
}: {
  pointId: string;
  canBackup: boolean;
  canRetain: boolean;
}) {
  const [open, setOpen] = useState(false),
    [retentionRepository, setRetentionRepository] = useState('');
  const query = usePointDestinations(pointId, open),
    operation = useQueuedOperation();
  return (
    <details
      className="mt-3 w-full rounded-md border p-3"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer text-sm font-medium">
        Cópias e resultados por destino
      </summary>
      {open && (
        <div className="mt-3 grid gap-3">
          {query.isPending ? (
            <p role="status">Consultando cópias…</p>
          ) : query.error ? (
            <p role="alert" className="text-destructive">
              Não foi possível consultar os destinos.{' '}
              <Button type="button" variant="outline" onClick={() => void query.refetch()}>
                Tentar novamente
              </Button>
            </p>
          ) : !query.data?.items.length ? (
            <p>Nenhum destino registrado para este ponto.</p>
          ) : (
            query.data.items.map((item) => (
              <div
                key={item.repositoryId}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted p-3"
              >
                <div>
                  <p className="text-sm font-medium">{item.name}</p>
                  <Badge variant="outline">
                    {item.status === 'concluida' ? 'Cópia verificada' : humanLabel(item.status)}
                  </Badge>
                  {item.verifiedAt && (
                    <p className="text-xs text-muted-foreground">
                      Verificada em {new Date(item.verifiedAt).toLocaleString('pt-BR')}
                    </p>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  {canBackup &&
                    !['concluida', 'expirado', 'retencao_pendente'].includes(item.status) && (
                      <Button
                        type="button"
                        variant="outline"
                        disabled={operation.busy}
                        onClick={() =>
                          operation.mutate({
                            path: 'replicate',
                            body: { recoveryPointId: pointId, repositoryId: item.repositoryId },
                          })
                        }
                      >
                        Repetir cópia
                      </Button>
                    )}
                  {canRetain && item.status === 'concluida' && (
                    <Button
                      type="button"
                      variant="outline"
                      disabled={operation.busy}
                      onClick={() => setRetentionRepository(item.repositoryId)}
                    >
                      Aplicar retenção
                    </Button>
                  )}
                </div>
              </div>
            ))
          )}
          {retentionRepository && (
            <div
              role="group"
              aria-label="Confirmar retenção"
              className="grid gap-2 rounded-md border p-3"
            >
              <p className="text-sm">
                Aplicar a retenção configurada neste repositório? Pontos antigos elegíveis serão
                removidos. O último ponto verificado e pontos protegidos por operações serão
                preservados.
              </p>
              <div className="flex gap-2">
                <Button type="button" variant="outline" onClick={() => setRetentionRepository('')}>
                  Cancelar
                </Button>
                <Button
                  type="button"
                  disabled={operation.busy}
                  onClick={() => {
                    operation.mutate({
                      path: 'retention',
                      body: { repositoryId: retentionRepository },
                    });
                    setRetentionRepository('');
                  }}
                >
                  Confirmar retenção
                </Button>
              </div>
            </div>
          )}
          <OperationFeedback operation={operation} />
        </div>
      )}
    </details>
  );
}

export function RestoreRepository({
  pointId,
  value,
  onChange,
  onAvailability,
}: {
  pointId: string;
  value: string;
  onChange: (id: string) => void;
  onAvailability: (available: boolean) => void;
}) {
  const id = useId(),
    query = usePointDestinations(pointId);
  const verified =
    query.data?.items.filter(
      (item) => item.status === 'concluida' && item.verifiedAt && item.snapshotId,
    ) ?? [];
  // The parent also enforces availability when submitting; the server rechecks the selected copy.
  const available = !query.isError && verified.some((item) => item.repositoryId === value);
  useEffect(() => onAvailability(available), [available, onAvailability]);
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>Cópia verificada para restaurar</Label>
      <select
        id={id}
        className="native-select"
        value={value}
        disabled={query.isPending}
        onChange={(event) => {
          onChange(event.target.value);
          onAvailability(verified.some((item) => item.repositoryId === event.target.value));
        }}
      >
        <option value="">Selecione um destino verificado</option>
        {verified.map((item) => (
          <option key={item.repositoryId} value={item.repositoryId}>
            {item.name}
          </option>
        ))}
      </select>
      {query.isPending ? (
        <p role="status" className="text-sm">
          Consultando cópias disponíveis…
        </p>
      ) : query.error ? (
        <p role="alert" className="text-sm text-destructive">
          Não foi possível consultar as cópias.{' '}
          <Button type="button" variant="outline" onClick={() => void query.refetch()}>
            Tentar novamente
          </Button>
        </p>
      ) : !verified.length ? (
        <p role="alert" className="text-sm text-destructive">
          Este ponto não possui cópia verificada disponível.
        </p>
      ) : !available ? (
        <p className="text-sm text-muted-foreground">Escolha uma cópia antes de confirmar.</p>
      ) : null}
    </div>
  );
}
