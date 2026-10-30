import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useFieldArray, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import {
  backupSystemInputSchema,
  systemEditorOptionsSchema,
  type backupSystemSchema,
} from '@apbackup/contracts';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { DataState } from '@/components/data-state';
import { api } from '@/lib/client-api';
type Values = z.infer<typeof backupSystemInputSchema>;
export function SystemEditor({
  system,
  onClose,
}: {
  system: z.infer<typeof backupSystemSchema> | null;
  onClose: () => void;
}) {
  const cache = useQueryClient();
  const options = useQuery({
    queryKey: ['systems', 'options'],
    queryFn: () => api('/api/systems/options', systemEditorOptionsSchema),
  });
  const form = useForm<z.input<typeof backupSystemInputSchema>, unknown, Values>({
    resolver: zodResolver(backupSystemInputSchema),
    defaultValues: system
      ? {
          id: system.id,
          serverId: system.serverId,
          name: system.name,
          description: system.description,
          scopeNotes: system.scopeNotes,
          sortOrder: system.sortOrder,
          components: system.components.map((c) => ({
            planId: c.planId,
            kind: c.kind,
            label: c.label,
            scopeNote: c.scopeNote,
            shared: c.shared,
          })),
        }
      : { serverId: '', name: '', description: '', scopeNotes: '', sortOrder: 0, components: [] },
  });
  const fields = useFieldArray({ control: form.control, name: 'components' });
  const server = form.watch('serverId');
  const save = useMutation({
    mutationFn: (v: Values) => api('/api/systems/save', z.object({ id: z.uuid() }), v),
    onSuccess: () => {
      void cache.invalidateQueries({ queryKey: ['systems'] });
      toast.success('Sistema e componentes salvos.');
      onClose();
    },
  });
  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o && !save.isPending) onClose();
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogTitle>{system ? 'Configurar sistema' : 'Novo sistema'}</DialogTitle>
        <DialogDescription>
          Organize planos existentes por aplicação, banco e arquivos. Agenda e destinos continuam
          definidos em cada plano.
        </DialogDescription>
        {options.isPending ? (
          <DataState state="loading" />
        ) : options.isError ? (
          <DataState state="error" onRetry={() => void options.refetch()} />
        ) : (
          <form className="space-y-4" onSubmit={form.handleSubmit((v) => save.mutate(v))}>
            <div className="space-y-2">
              <Label htmlFor="system-name">Nome do sistema</Label>
              <Input id="system-name" {...form.register('name')} />
              {form.formState.errors.name && (
                <p role="alert">Informe um nome de até 120 caracteres.</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="system-server">Servidor</Label>
              <input type="hidden" {...form.register('serverId')} />
              <select
                id="system-server"
                className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={server}
                onChange={(e) =>
                  form.setValue('serverId', e.target.value, { shouldValidate: true })
                }
                disabled={Boolean(system) || fields.fields.length > 0}
              >
                <option value="">Selecione</option>
                {options.data?.servers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              {form.formState.errors.serverId && (
                <p role="alert" className="text-sm text-destructive">
                  Selecione um servidor.
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="system-description">Descrição</Label>
              <Input id="system-description" {...form.register('description')} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="system-scope">Escopo e dependências externas</Label>
              <textarea
                id="system-scope"
                className="min-h-20 w-full rounded-md border border-input bg-background p-3 text-sm"
                {...form.register('scopeNotes')}
              />
            </div>
            <div className="space-y-3">
              <h3 className="text-sm font-semibold">Componentes vinculados</h3>
              {fields.fields.map((field, index) => (
                <fieldset key={field.id} className="space-y-3 rounded-lg border p-4">
                  <legend className="px-1 text-xs">Componente {index + 1}</legend>
                  <Label htmlFor={`kind-${index}`}>Tipo</Label>
                  <select
                    id={`kind-${index}`}
                    className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm"
                    {...form.register(`components.${index}.kind`)}
                  >
                    <option value="application">Aplicação</option>
                    <option value="database">Banco de dados</option>
                    <option value="files">Arquivos</option>
                  </select>
                  <Label htmlFor={`label-${index}`}>Nome legível</Label>
                  <Input id={`label-${index}`} {...form.register(`components.${index}.label`)} />
                  <Label htmlFor={`plan-${index}`}>Plano existente</Label>
                  <select
                    id={`plan-${index}`}
                    className="h-11 w-full rounded-md border border-input bg-background px-3 text-sm"
                    {...form.register(`components.${index}.planId`)}
                  >
                    <option value="">Selecione o plano</option>
                    {options.data?.plans
                      .filter((p) => p.serverId === server)
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                  </select>
                  <Label htmlFor={`scope-${index}`}>Limites da recuperação e dependências</Label>
                  <Input
                    id={`scope-${index}`}
                    {...form.register(`components.${index}.scopeNote`)}
                  />
                  <label className="flex min-h-11 items-center gap-2 text-sm">
                    <input type="checkbox" {...form.register(`components.${index}.shared`)} />
                    Plano compartilhado com outros sistemas
                  </label>
                  <Button type="button" variant="outline" onClick={() => fields.remove(index)}>
                    Remover vínculo
                  </Button>
                </fieldset>
              ))}
              <Button
                type="button"
                variant="outline"
                disabled={!server}
                onClick={() =>
                  fields.append({
                    planId: '',
                    kind: 'application',
                    label: '',
                    scopeNote: '',
                    shared: false,
                  })
                }
              >
                Adicionar componente
              </Button>
            </div>
            {Object.keys(form.formState.errors).length > 0 && (
              <p role="alert" className="text-sm text-destructive">
                Revise nome, servidor e componentes. Cada vínculo deve ter nome, plano e tipo
                únicos.
              </p>
            )}
            {save.isError && (
              <p role="alert" className="text-sm text-destructive">
                Não foi possível salvar. Confira os campos e confirme sua senha e segundo fator em
                Segurança da conta.
              </p>
            )}
            <div className="flex flex-wrap justify-end gap-2">
              <Button type="button" variant="outline" disabled={save.isPending} onClick={onClose}>
                Cancelar
              </Button>
              <Button type="submit" disabled={save.isPending}>
                {save.isPending ? 'Salvando…' : 'Salvar sistema'}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
