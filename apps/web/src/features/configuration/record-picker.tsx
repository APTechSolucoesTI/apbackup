import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { optionsResultSchema } from '@apbackup/contracts';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { configurationRequest } from './client';
import { humanLabel } from '@/lib/listing';
type OptionKind = 'servers' | 'resources' | 'profiles' | 'destinations';
function useOptions(
  kind: OptionKind,
  ids: string[],
  search: string,
  cacheScope: string,
  serverId?: string,
) {
  const params = new URLSearchParams({ kind, search, ids: ids.join(',') });
  if (serverId) params.set('serverId', serverId);
  return useQuery({
    queryKey: ['configuration-options', cacheScope, kind, ids.join(','), search, serverId],
    queryFn: ({ signal }) =>
      configurationRequest(`options?${params}`, optionsResultSchema, undefined, signal),
    staleTime: 0,
  });
}
export function RecordPicker({
  label,
  kind,
  value,
  onChange,
  cacheScope,
  disabled = false,
}: {
  label: string;
  kind: OptionKind;
  value: string;
  onChange: (value: string) => void;
  cacheScope: string;
  disabled?: boolean;
}) {
  const [search, setSearch] = useState(''),
    query = useOptions(kind, value ? [value] : [], search, cacheScope);
  return (
    <div className="record-picker">
      <label className="field-label">
        {label}
        <Input
          type="search"
          aria-label={`Buscar ${label.toLocaleLowerCase('pt-BR')}`}
          placeholder="Buscar pelo nome…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          disabled={disabled}
        />
        <select
          className="native-select"
          aria-label={label}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled || query.isPending}
        >
          <option value="">{query.isPending ? 'Carregando…' : 'Selecione uma opção'}</option>
          {query.data?.items.map((item) => (
            <option value={item.id} key={item.id}>
              {item.label} · {humanLabel(item.detail)}
            </option>
          ))}
        </select>
      </label>
      {query.isError && (
        <div role="alert" className="field-error">
          Não foi possível carregar as opções.{' '}
          <Button variant="link" type="button" onClick={() => void query.refetch()}>
            Tentar novamente
          </Button>
        </div>
      )}
      {query.data && query.data.total > 250 && (
        <p className="support-text">
          Exibindo até 250 opções. Refine a busca para encontrar outros cadastros.
        </p>
      )}
    </div>
  );
}
export function MultiRecordPicker({
  label,
  kind,
  values,
  onChange,
  cacheScope,
  disabled = false,
  serverId,
  flags,
  onFlagChange,
  flagLabel = 'Obrigatório',
}: {
  label: string;
  kind: OptionKind;
  values: string[];
  onChange: (values: string[]) => void;
  cacheScope: string;
  disabled?: boolean;
  serverId?: string;
  flags?: Record<string, boolean>;
  onFlagChange?: (id: string, value: boolean) => void;
  flagLabel?: string;
}) {
  const [search, setSearch] = useState(''),
    query = useOptions(kind, values, search, cacheScope, serverId);
  return (
    <fieldset className="multi-picker">
      <legend className="field-label">{label}</legend>
      <Input
        type="search"
        aria-label={`Buscar ${label.toLocaleLowerCase('pt-BR')}`}
        placeholder="Buscar pelo nome…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        disabled={disabled}
      />
      <div className="multi-picker-options" aria-busy={query.isFetching}>
        {query.isPending ? (
          <p role="status">Carregando opções…</p>
        ) : query.isError ? (
          <p role="alert">
            Não foi possível carregar.{' '}
            <Button type="button" variant="link" onClick={() => void query.refetch()}>
              Tentar novamente
            </Button>
          </p>
        ) : query.data.items.length === 0 ? (
          <p>Nenhum cadastro disponível. Cadastre as dependências antes de continuar.</p>
        ) : (
          query.data.items.map((item) => (
            <div className="multi-picker-option" key={item.id}>
              <label>
                <Checkbox
                  aria-label={`Selecionar ${item.label}`}
                  checked={values.includes(item.id)}
                  disabled={disabled}
                  onCheckedChange={(checked) =>
                    onChange(checked ? [...values, item.id] : values.filter((id) => id !== item.id))
                  }
                />
                <span>
                  {item.label}
                  <small>{humanLabel(item.detail)}</small>
                </span>
              </label>
              {values.includes(item.id) && onFlagChange && (
                <label className="multi-picker-flag">
                  <Checkbox
                    aria-label={`${flagLabel}: ${item.label}`}
                    checked={flags?.[item.id] ?? true}
                    disabled={disabled}
                    onCheckedChange={(value) => onFlagChange(item.id, Boolean(value))}
                  />
                  {flagLabel}
                </label>
              )}
            </div>
          ))
        )}
      </div>
      <p className="support-text">
        {values.length} selecionado(s)
        {query.data && query.data.total > 250
          ? ' · Refine a busca para encontrar mais opções.'
          : ''}
      </p>
    </fieldset>
  );
}
