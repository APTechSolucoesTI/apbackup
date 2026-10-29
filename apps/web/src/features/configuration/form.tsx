import { useEffect, useId, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  serverInputSchema,
  resourceInputSchema,
  profileInputSchema,
  destinationInputSchema,
  planInputSchema,
  resourceKindSchema,
  destinationKindSchema,
  destinationStatusSchema,
  destinationCredentialSchema,
  consistencySchema,
  restoreCapabilitySchema,
  type ConfigurationKind,
} from '@apbackup/contracts';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { humanLabel } from '@/lib/listing';
import {
  configurationRequest,
  ConfigurationRequestError,
  readSchemas,
  type ConfigurationRecord,
} from './client';
import { RecordPicker, MultiRecordPicker } from './record-picker';
import { DestinationAssessment } from '@/features/destinations/operations';
const shape = z.object({
  name: z.string().trim().min(1, 'Informe um nome.').max(200),
  externalIdentity: z.string(),
  hostname: z.string(),
  serverId: z.string(),
  resourceKind: resourceKindSchema,
  destinationKind: z.string(),
  engine: z.enum(['', 'restic', 'pbs']),
  rootPath: z.string(),
  destinationStatus: destinationStatusSchema,
  username: z.string(),
  secret: z.string(),
  backend: z.string(),
  endpoint: z.string(),
  bucket: z.string(),
  region: z.string(),
  port: z.number().int().min(0).max(65535),
  share: z.string(),
  domain: z.string(),
  rootFolderId: z.string(),
  hostKey: z.string(),
  accessKey: z.string(),
  secretKey: z.string(),
  sessionToken: z.string(),
  accessPassword: z.string(),
  clientId: z.string(),
  clientSecret: z.string(),
  driveTokenText: z.string().refine((value) => {
    if (!value) return true;
    try {
      return destinationCredentialSchema.shape.driveToken.safeParse(JSON.parse(value)).success;
    } catch {
      return false;
    }
  }, 'Informe o JSON OAuth válido gerado pelo Rclone.'),
  adapterName: z.string(),
  adapterVersion: z.string(),
  consistency: z.string(),
  resources: z.array(z.object({ resourceId: z.string(), required: z.boolean() })),
  restoreCapabilities: z.array(restoreCapabilitySchema),
  dependencies: z.array(z.object({ dependsOnResourceId: z.string(), shared: z.boolean() })),
  profileVersionId: z.string(),
  destinations: z.array(z.object({ destinationId: z.string(), required: z.boolean() })),
  days: z.number().int().positive(),
  evidenceDays: z.number().int().positive(),
  localTime: z.string(),
  timezone: z.string(),
  enabled: z.boolean(),
});
type Values = z.infer<typeof shape>;
const schemas = {
  servers: serverInputSchema,
  resources: resourceInputSchema,
  systems: profileInputSchema,
  destinations: destinationInputSchema,
  plans: planInputSchema,
};
function payload(kind: ConfigurationKind, v: Values): unknown {
  if (kind === 'servers')
    return { name: v.name, externalIdentity: v.externalIdentity, hostname: v.hostname || null };
  if (kind === 'resources')
    return {
      name: v.name,
      serverId: v.serverId,
      kind: v.resourceKind,
      externalIdentity: v.externalIdentity,
      dependencies: v.dependencies,
    };
  if (kind === 'systems')
    return {
      name: v.name,
      serverId: v.serverId,
      externalIdentity: v.externalIdentity,
      adapter: { name: v.adapterName, version: v.adapterVersion },
      consistency: v.consistency,
      resources: v.resources,
      restoreCapabilities: v.restoreCapabilities,
    };
  if (kind === 'destinations')
    return {
      name: v.name,
      host: v.hostname || null,
      kind: v.destinationKind || null,
      engine: v.engine || null,
      rootPath: v.rootPath || null,
      status: v.destinationStatus,
      configuration:
        (v.destinationKind === 'local' && v.backend !== 'mounted') || !v.destinationKind
          ? null
          : {
              backend: v.destinationKind === 'local' ? 'mounted' : v.destinationKind,
              ...(v.endpoint ? { endpoint: v.endpoint } : {}),
              ...(v.bucket ? { bucket: v.bucket } : {}),
              ...(v.region ? { region: v.region } : {}),
              ...(v.port ? { port: v.port } : {}),
              ...(v.share ? { share: v.share } : {}),
              ...(v.domain ? { domain: v.domain } : {}),
              ...(v.rootFolderId ? { rootFolderId: v.rootFolderId } : {}),
              ...(v.hostKey ? { hostKey: v.hostKey } : {}),
            },
      ...(v.secret ||
      v.username ||
      v.accessPassword ||
      v.accessKey ||
      v.secretKey ||
      v.sessionToken ||
      v.driveTokenText ||
      v.clientId ||
      v.clientSecret
        ? {
            credential: {
              ...(v.username ? { username: v.username } : {}),
              secret: v.secret,
              ...(v.accessPassword ? { password: v.accessPassword } : {}),
              ...(v.accessKey ? { accessKey: v.accessKey } : {}),
              ...(v.secretKey ? { secretKey: v.secretKey } : {}),
              ...(v.sessionToken ? { sessionToken: v.sessionToken } : {}),
              ...(v.clientId ? { clientId: v.clientId } : {}),
              ...(v.clientSecret ? { clientSecret: v.clientSecret } : {}),
              ...(v.driveTokenText ? { driveToken: JSON.parse(v.driveTokenText) as unknown } : {}),
            },
          }
        : {}),
    };
  return {
    name: v.name,
    profileVersionId: v.profileVersionId,
    destinations: v.destinations,
    retention: { days: v.days, evidenceDays: v.evidenceDays, protectLastVerified: true },
    schedule: { localTime: v.localTime, timezone: v.timezone },
    enabled: v.enabled,
  };
}
function fieldFor(path: PropertyKey[]): keyof Values {
  const first = String(path[0] ?? 'name');
  if (first === 'kind') return 'resourceKind';
  if (first === 'host') return 'hostname';
  if (first === 'status') return 'destinationStatus';
  if (first === 'adapter') return path[1] === 'name' ? 'adapterName' : 'adapterVersion';
  if (first === 'retention') return path[1] === 'days' ? 'days' : 'evidenceDays';
  if (first === 'schedule') return path[1] === 'localTime' ? 'localTime' : 'timezone';
  if (first === 'credential') {
    const key = String(path[1]);
    return key === 'password'
      ? 'accessPassword'
      : key === 'driveToken'
        ? 'driveTokenText'
        : key in shape.shape
          ? (key as keyof Values)
          : 'secret';
  }
  if (first === 'configuration') {
    const key = String(path[1]);
    return key in shape.shape ? (key as keyof Values) : 'rootPath';
  }
  return first in shape.shape ? (first as keyof Values) : 'name';
}
function defaults(record?: ConfigurationRecord): Values {
  const value: Values = {
    name: '',
    externalIdentity: '',
    hostname: '',
    serverId: '',
    resourceKind: 'postgresql',
    destinationKind: '',
    engine: '',
    rootPath: '',
    destinationStatus: 'aguardando_configuracao',
    username: '',
    secret: '',
    backend: '',
    endpoint: '',
    bucket: '',
    region: '',
    port: 0,
    share: '',
    domain: '',
    rootFolderId: '',
    hostKey: '',
    accessKey: '',
    secretKey: '',
    sessionToken: '',
    accessPassword: '',
    clientId: '',
    clientSecret: '',
    driveTokenText: '',
    adapterName: '',
    adapterVersion: '',
    consistency: '',
    resources: [],
    restoreCapabilities: [],
    dependencies: [],
    profileVersionId: '',
    destinations: [],
    days: 7,
    evidenceDays: 90,
    localTime: '03:00',
    timezone: 'America/Sao_Paulo',
    enabled: false,
  };
  if (!record) return value;
  value.name = record.name;
  if ('externalIdentity' in record) value.externalIdentity = record.externalIdentity;
  if ('hostname' in record) value.hostname = record.hostname ?? '';
  if ('serverId' in record) value.serverId = record.serverId;
  if ('dependencies' in record) {
    value.resourceKind = record.kind;
    value.dependencies = record.dependencies.map((d) => ({
      dependsOnResourceId: d.dependsOnResourceId,
      shared: d.shared,
    }));
  }
  if ('definition' in record) {
    value.adapterName = record.definition.adapter.name;
    value.adapterVersion = record.definition.adapter.version;
    value.consistency = record.definition.consistency;
    value.resources = record.definition.resources;
    value.restoreCapabilities = record.definition.restoreCapabilities;
  }
  if ('hasCredential' in record) {
    value.hostname = record.host ?? '';
    value.destinationKind = record.kind ?? '';
    value.engine = record.engine ?? '';
    value.rootPath = record.rootPath ?? '';
    value.destinationStatus = record.status;
    if ('configuration' in record && record.configuration) {
      const config = record.configuration;
      value.backend = config.backend;
      value.endpoint = config.endpoint ?? '';
      value.bucket = config.bucket ?? '';
      value.region = config.region ?? '';
      value.port = config.port ?? 0;
      value.share = config.share ?? '';
      value.domain = config.domain ?? '';
      value.rootFolderId = config.rootFolderId ?? '';
      value.hostKey = config.hostKey ?? '';
    }
  }
  if ('retention' in record) {
    value.profileVersionId = record.profileVersionId;
    value.destinations = record.destinations.map((d) => ({
      destinationId: d.destinationId,
      required: d.required,
    }));
    value.days = record.retention.days;
    value.evidenceDays = record.retention.evidenceDays;
    value.localTime = record.schedule.localTime;
    value.timezone = record.schedule.timezone;
    value.enabled = record.enabled;
  }
  return value;
}
export function ConfigurationForm({
  kind,
  record,
  readOnly = false,
  cacheScope,
  onSaved,
  onCancel,
  onPendingChange,
}: {
  kind: ConfigurationKind;
  record?: ConfigurationRecord;
  readOnly?: boolean;
  cacheScope: string;
  onSaved: () => Promise<void>;
  onCancel: () => void;
  onPendingChange: (pending: boolean) => void;
}) {
  const prefix = useId(),
    [error, setError] = useState('');
  const schema = shape.superRefine((values, ctx) => {
    const parsed = schemas[kind].safeParse(payload(kind, values));
    if (!parsed.success)
      for (const issue of parsed.error.issues) {
        let field = fieldFor(issue.path);
        if (kind === 'destinations' && issue.path[0] === 'kind') field = 'destinationKind';
        ctx.addIssue({
          code: 'custom',
          path: [field],
          message:
            field === 'externalIdentity'
              ? 'Informe uma identificação externa válida.'
              : field === 'serverId'
                ? 'Selecione um servidor.'
                : field === 'profileVersionId'
                  ? 'Selecione uma versão de sistema.'
                  : field === 'adapterName'
                    ? 'Informe a identificação do conector.'
                    : field === 'adapterVersion'
                      ? 'Informe uma versão no formato 1.0.0.'
                      : field === 'consistency'
                        ? 'Selecione o nível de consistência.'
                        : issue.message.startsWith('Invalid') || issue.message.startsWith('Too ')
                          ? 'Revise este campo.'
                          : issue.message,
        });
      }
  });
  const form = useForm<Values>({ resolver: zodResolver(schema), defaultValues: defaults(record) }),
    values = form.watch();
  useEffect(() => {
    onPendingChange(form.formState.isSubmitting);
  }, [form.formState.isSubmitting, onPendingChange]);
  useEffect(() => () => onPendingChange(false), [onPendingChange]);
  const field = (name: keyof Values, label: string, type = 'text', help?: string) => (
    <div className="form-field" key={name}>
      <Label htmlFor={`${prefix}-${name}`}>{label}</Label>
      <Input
        id={`${prefix}-${name}`}
        type={type}
        {...form.register(name, type === 'number' ? { valueAsNumber: true } : {})}
        aria-invalid={Boolean(form.formState.errors[name])}
        aria-describedby={`${prefix}-${name}-error`}
      />
      {help && <p className="support-text">{help}</p>}
      <p id={`${prefix}-${name}-error`} className="field-error">
        {form.formState.errors[name]?.message}
      </p>
    </div>
  );
  const message = (name: keyof Values) => (
    <p className="field-error">{form.formState.errors[name]?.message}</p>
  );
  return (
    <form
      noValidate
      className="configuration-form"
      onSubmit={form.handleSubmit(async (value) => {
        setError('');
        try {
          const body = payload(kind, value);
          await configurationRequest(
            record ? `${kind}/${record.id}` : kind,
            readSchemas[kind],
            record
              ? { ...(body as Record<string, unknown>), expectedUpdatedAt: record.updatedAt }
              : body,
          );
          await onSaved();
        } catch (cause) {
          if (cause instanceof ConfigurationRequestError) {
            setError(cause.message);
            for (const [key, message] of Object.entries(cause.fields))
              form.setError(fieldFor(key.split('.')), { message });
          } else setError('Não foi possível salvar. Tente novamente.');
        }
      })}
    >
      <fieldset disabled={readOnly || form.formState.isSubmitting} className="configuration-fields">
        {field('name', 'Nome')}
        {kind !== 'destinations' &&
          kind !== 'plans' &&
          field(
            'externalIdentity',
            'Identificação externa',
            'text',
            'Identificação estável da origem ou do recurso. Não inclua senhas ou URLs autenticadas.',
          )}
        {(kind === 'servers' || kind === 'destinations') &&
          field('hostname', 'Hostname ou endereço')}
        {(kind === 'resources' || kind === 'systems') && (
          <>
            <RecordPicker
              label="Servidor"
              kind="servers"
              value={values.serverId}
              onChange={(value) => form.setValue('serverId', value, { shouldValidate: true })}
              cacheScope={cacheScope}
            />
            {message('serverId')}
          </>
        )}
        {kind === 'resources' && (
          <>
            <label className="form-field">
              Tipo de recurso
              <select className="native-select" {...form.register('resourceKind')}>
                {resourceKindSchema.options.map((option) => (
                  <option key={option} value={option}>
                    {humanLabel(option)}
                  </option>
                ))}
              </select>
            </label>
            <details>
              <summary>Dependências do recurso</summary>
              <MultiRecordPicker
                label="Dependências"
                kind="resources"
                values={values.dependencies.map((d) => d.dependsOnResourceId)}
                onChange={(ids) =>
                  form.setValue(
                    'dependencies',
                    ids.map(
                      (id) =>
                        values.dependencies.find((d) => d.dependsOnResourceId === id) ?? {
                          dependsOnResourceId: id,
                          shared: false,
                        },
                    ),
                  )
                }
                flags={Object.fromEntries(
                  values.dependencies.map((d) => [d.dependsOnResourceId, d.shared]),
                )}
                flagLabel="Compartilhado"
                onFlagChange={(id, shared) =>
                  form.setValue(
                    'dependencies',
                    values.dependencies.map((d) =>
                      d.dependsOnResourceId === id ? { ...d, shared } : d,
                    ),
                  )
                }
                cacheScope={cacheScope}
              />
              {message('dependencies')}
            </details>
          </>
        )}
        {kind === 'systems' && (
          <>
            <MultiRecordPicker
              label="Recursos do sistema"
              kind="resources"
              values={values.resources.map((r) => r.resourceId)}
              onChange={(ids) =>
                form.setValue(
                  'resources',
                  ids.map(
                    (id) =>
                      values.resources.find((r) => r.resourceId === id) ?? {
                        resourceId: id,
                        required: true,
                      },
                  ),
                  { shouldValidate: true },
                )
              }
              flags={Object.fromEntries(values.resources.map((r) => [r.resourceId, r.required]))}
              onFlagChange={(id, required) =>
                form.setValue(
                  'resources',
                  values.resources.map((r) => (r.resourceId === id ? { ...r, required } : r)),
                )
              }
              cacheScope={cacheScope}
            />
            {message('resources')}
            <div className="form-columns">
              {field('adapterName', 'Identificação do conector')}
              {field('adapterVersion', 'Versão do conector')}
            </div>
            <p className="support-text">
              A versão deve corresponder ao conector que executará a captura. Este cadastro não
              certifica compatibilidade ou recuperação.
            </p>
            <label className="form-field">
              Nível de consistência
              <select className="native-select" {...form.register('consistency')}>
                <option value="">Selecione o nível planejado</option>
                {consistencySchema.options.map((option) => (
                  <option key={option} value={option}>
                    {
                      {
                        application_consistent: 'Consistente com a aplicação',
                        transactional: 'Transacional',
                        crash_consistent: 'Consistente após interrupção',
                        file_consistent: 'Consistente por arquivo',
                      }[option]
                    }
                  </option>
                ))}
              </select>
              {message('consistency')}
            </label>
            <fieldset className="checkbox-group">
              <legend>Escopos de restauração</legend>
              {restoreCapabilitySchema.options.map((option) => (
                <label key={option}>
                  <Checkbox
                    aria-label={
                      {
                        system: 'Sistema completo',
                        database: 'Banco de dados',
                        files: 'Arquivos',
                        vm: 'Máquina virtual',
                        host_configuration: 'Configuração do host',
                      }[option]
                    }
                    checked={values.restoreCapabilities.includes(option)}
                    onCheckedChange={(checked) =>
                      form.setValue(
                        'restoreCapabilities',
                        checked
                          ? [...values.restoreCapabilities, option]
                          : values.restoreCapabilities.filter((c) => c !== option),
                        { shouldValidate: true },
                      )
                    }
                  />
                  {
                    {
                      system: 'Sistema completo',
                      database: 'Banco de dados',
                      files: 'Arquivos',
                      vm: 'Máquina virtual',
                      host_configuration: 'Configuração do host',
                    }[option]
                  }
                </label>
              ))}
            </fieldset>
            {message('restoreCapabilities')}
          </>
        )}
        {kind === 'destinations' && (
          <>
            <div className="form-columns">
              <label className="form-field">
                Protocolo
                <select className="native-select" {...form.register('destinationKind')}>
                  <option value="">A definir</option>
                  {destinationKindSchema.options
                    .filter((option) => option !== 'pbs')
                    .map((option) => (
                      <option value={option} key={option}>
                        {humanLabel(option)}
                      </option>
                    ))}
                </select>
                {message('destinationKind')}
              </label>
              <label className="form-field">
                Mecanismo de backup
                <select className="native-select" {...form.register('engine')}>
                  <option value="">A definir</option>
                  <option value="restic">Restic</option>
                </select>
                {message('engine')}
              </label>
            </div>
            {field(
              'rootPath',
              'Pasta dedicada',
              'text',
              'Pode permanecer vazia enquanto o destino aguarda preparação. Não use a raiz do servidor.',
            )}
            {values.destinationKind === 'local' && (
              <label className="form-field">
                Tipo de diretório
                <select className="native-select" {...form.register('backend')}>
                  <option value="">Repositório relativo na raiz privada do agente</option>
                  <option value="mounted">Diretório absoluto já montado e aprovado (NAS)</option>
                </select>
                <p className="support-text">
                  O NAS deve estar preparado e aprovado no agente. O cadastro não monta
                  compartilhamentos nem comprova acesso.
                </p>
              </label>
            )}
            {values.destinationKind === 's3' && (
              <div className="form-columns">
                {field('endpoint', 'Endpoint S3 HTTPS', 'url')}
                {field('bucket', 'Bucket S3')}
                {field('region', 'Região (opcional)')}
              </div>
            )}
            {(values.destinationKind === 'sftp' || values.destinationKind === 'smb') && (
              <>
                {field('port', 'Porta (0 usa o padrão)', 'number')}
                {values.destinationKind === 'smb' ? (
                  <>
                    {field('share', 'Compartilhamento SMB')}
                    {field('domain', 'Domínio (opcional)')}
                  </>
                ) : (
                  field(
                    'hostKey',
                    'Chave pública SSH conhecida',
                    'text',
                    'Use a chave verificada do servidor, no formato ssh-ed25519 BASE64 ou ssh-rsa BASE64. Não aceite uma chave desconhecida automaticamente.',
                  )
                )}
              </>
            )}
            {values.destinationKind === 'google_drive' &&
              field('rootFolderId', 'ID da pasta autorizada no Drive (opcional)')}
            {record && 'assessment' in record && (
              <section className="credential-fields" aria-label="Capacidades avaliadas do destino">
                <h3>Capacidades do destino</h3>
                {record.assessment ? (
                  <>
                    <p className="support-text">
                      Avaliação da revisão {record.assessment.configurationRevision}, em{' '}
                      {new Date(record.assessment.assessedAt).toLocaleString('pt-BR')}.
                    </p>
                    <ul className="support-text">
                      {(
                        [
                          ['encrypted', 'Criptografia'],
                          ['platformRetention', 'Retenção pela plataforma'],
                          ['restrictedDeletion', 'Exclusão restrita'],
                          ['independentSnapshot', 'Snapshot independente'],
                          ['immutable', 'Imutabilidade'],
                        ] as const
                      ).map(([key, label]) => (
                        <li key={key}>
                          {label}:{' '}
                          {record.assessment!.capabilities[key] ? 'disponível' : 'não disponível'}
                        </li>
                      ))}
                    </ul>
                    {(!record.assessment.capabilities.restrictedDeletion ||
                      !record.assessment.capabilities.independentSnapshot ||
                      !record.assessment.capabilities.immutable) && (
                      <p className="support-text">
                        Este destino tem limitações de proteção contra exclusão. A avaliação não
                        garante sobrevivência ao comprometimento administrativo completo da origem.
                      </p>
                    )}
                  </>
                ) : (
                  <p className="support-text">
                    Aguardando avaliação da configuração atual. Nenhuma capacidade de proteção foi
                    comprovada.
                  </p>
                )}
              </section>
            )}
            <fieldset className="credential-fields">
              <legend>Credencial de acesso</legend>
              {record && 'hasCredential' in record && record.hasCredential && (
                <p className="support-text">
                  Já existe uma credencial protegida. Deixe os campos vazios para preservá-la; seu
                  conteúdo não pode ser consultado.
                </p>
              )}
              {!readOnly && (
                <>
                  {(values.destinationKind === 'sftp' || values.destinationKind === 'smb') && (
                    <>
                      {field('username', 'Usuário de acesso')}
                      {field('accessPassword', 'Senha de acesso', 'password')}
                    </>
                  )}
                  {values.destinationKind === 's3' && (
                    <>
                      {field('accessKey', 'Access Key S3', 'password')}
                      {field('secretKey', 'Secret Key S3', 'password')}
                      {field('sessionToken', 'Session Token temporário (opcional)', 'password')}
                    </>
                  )}
                  {values.destinationKind === 'google_drive' && (
                    <>
                      {field(
                        'driveTokenText',
                        'Token OAuth do Rclone (JSON)',
                        'password',
                        'Use o token autorizado da sua conta. Ele fica cifrado; não cole chaves na conversa ou em logs.',
                      )}
                      {field('clientId', 'Client ID OAuth próprio (opcional)')}
                      {field('clientSecret', 'Client Secret OAuth próprio (opcional)', 'password')}
                    </>
                  )}
                  {field(
                    'secret',
                    'Senha de criptografia do repositório Restic',
                    'password',
                    'Obrigatória ao cadastrar ou substituir credenciais. Guarde fora do servidor. Não é a senha de acesso do NAS/S3/Drive; será cifrada e nunca retornada na leitura.',
                  )}
                </>
              )}
            </fieldset>
            <label className="form-field">
              Estado da configuração
              <select className="native-select" {...form.register('destinationStatus')}>
                {destinationStatusSchema.options.map((option) => (
                  <option value={option} key={option}>
                    {humanLabel(option)}
                  </option>
                ))}
              </select>
              {message('destinationStatus')}
            </label>
            <p className="support-text">
              Ativo exige configuração completa. Conectividade, capacidade do conector e cobertura
              dependem de verificações reais; não são comprovadas por este cadastro.
            </p>
            {record && !readOnly && (
              <DestinationAssessment
                destinationId={record.id}
                cacheScope={cacheScope}
                dirty={form.formState.isDirty}
              />
            )}
          </>
        )}
        {kind === 'plans' && (
          <>
            <RecordPicker
              label="Versão do sistema"
              kind="profiles"
              value={values.profileVersionId}
              onChange={(value) =>
                form.setValue('profileVersionId', value, { shouldValidate: true })
              }
              cacheScope={cacheScope}
            />
            {message('profileVersionId')}
            <MultiRecordPicker
              label="Destinos do plano"
              kind="destinations"
              values={values.destinations.map((d) => d.destinationId)}
              onChange={(ids) =>
                form.setValue(
                  'destinations',
                  ids.map(
                    (id) =>
                      values.destinations.find((d) => d.destinationId === id) ?? {
                        destinationId: id,
                        required: true,
                      },
                  ),
                  { shouldValidate: true },
                )
              }
              flags={Object.fromEntries(
                values.destinations.map((d) => [d.destinationId, d.required]),
              )}
              onFlagChange={(id, required) =>
                form.setValue(
                  'destinations',
                  values.destinations.map((d) => (d.destinationId === id ? { ...d, required } : d)),
                )
              }
              cacheScope={cacheScope}
            />
            {message('destinations')}
            <div className="form-columns">
              {field('days', 'Retenção em dias', 'number')}
              {field('evidenceDays', 'Evidências em dias', 'number')}
              {field('localTime', 'Horário da agenda', 'time')}
              {field('timezone', 'Fuso horário')}
            </div>
            <p className="support-text">
              O último ponto verificado é protegido da retenção. Cada execução mantém sua versão de
              sistema, mesmo que este plano seja editado depois.
            </p>
            <label className="confirmation-label">
              <Checkbox
                checked={values.enabled}
                onCheckedChange={(enabled) => form.setValue('enabled', Boolean(enabled))}
              />
              Habilitar plano e agenda
            </label>
            {message('enabled')}
            <p className="support-text">
              Deixe desabilitado durante a preparação. A ativação exige todos os destinos
              obrigatórios configurados e capacidades verificadas pelo conector.
            </p>
          </>
        )}
      </fieldset>
      {record && 'version' in record && (
        <p className="support-text">
          Versão atual: {record.version}. Salvar uma edição cria uma nova versão; execuções
          anteriores preservam a original.
        </p>
      )}
      {error && (
        <div role="alert" className="form-error">
          <p>{error}</p>
          <a href="/security" target="_blank" rel="noreferrer">
            Confirmar identidade em outra aba
          </a>
        </div>
      )}
      <div className="configuration-form-footer">
        <Button
          type="button"
          variant="outline"
          disabled={form.formState.isSubmitting}
          onClick={onCancel}
        >
          {readOnly ? 'Fechar' : 'Cancelar'}
        </Button>
        {!readOnly && (
          <Button type="submit" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting ? 'Salvando…' : 'Salvar'}
          </Button>
        )}
      </div>
    </form>
  );
}
