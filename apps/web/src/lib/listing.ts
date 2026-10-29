import { z } from 'zod';
import type { SearchSchemaInput } from '@tanstack/react-router';
export const catalogKinds = [
  'servers',
  'systems',
  'resources',
  'destinations',
  'plans',
  'executions',
  'coverage',
] as const;
export const listQuerySchema = z.object({
  kind: z.enum(catalogKinds).default('servers'),
  page: z.coerce.number().int().min(1).max(1000000).default(1),
  pageSize: z.coerce
    .number()
    .pipe(z.union([z.literal(10), z.literal(20), z.literal(30), z.literal(50), z.literal(100)]))
    .default(10),
  search: z.string().trim().max(200).default(''),
  sort: z.enum(['name', 'detail', 'status', 'createdAt']).default('name'),
  direction: z.enum(['asc', 'desc', 'none']).default('none'),
  status: z.string().max(64).default(''),
});
export type ListQuery = z.infer<typeof listQuerySchema>;
export const listSearchSchema = listQuerySchema.omit({ kind: true });
export type ListSearchInput = SearchSchemaInput & z.input<typeof listSearchSchema>;
export type CatalogKind = ListQuery['kind'];
export const catalogRowSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  detail: z.string(),
  status: z.string(),
  createdAt: z.string(),
});
export const listResultSchema = z.object({
  items: z.array(catalogRowSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: listQuerySchema.shape.pageSize,
});
export type CatalogRow = z.infer<typeof catalogRowSchema>;
export type ListResult = z.infer<typeof listResultSchema>;
export const labels: Record<string, string> = {
  arquivado: 'Arquivado',
  aguardando_configuracao: 'Aguardando configuração',
  ativo: 'Ativo',
  indisponivel: 'Indisponível',
  desabilitado: 'Desabilitado',
  cadastrado: 'Cadastrado',
  configurado: 'Configurado',
  habilitado: 'Habilitado',
  incomplete: 'Incompleto',
  complete: 'Completo',
  quarantined: 'Em quarentena',
  expired: 'Expirado',
  aguardando: 'Aguardando',
  verificando: 'Verificando',
  capturando: 'Capturando',
  enviando: 'Enviando',
  verificando_destino: 'Verificando destino',
  concluida: 'Concluída',
  falhas_parciais: 'Falhas parciais',
  falhou: 'Falhou',
  cancelada: 'Cancelada',
  exige_intervencao: 'Exige intervenção',
  postgresql: 'PostgreSQL',
  files: 'Arquivos',
  compose: 'Docker Compose',
  swarm: 'Docker Swarm',
  dokploy: 'Dokploy',
  redis: 'Redis',
  supabase_schema: 'Schema Supabase',
  supabase_auth: 'Autenticação Supabase',
  supabase_storage: 'Storage Supabase',
  vm: 'Máquina virtual',
  proxmox_host: 'Host Proxmox',
  pbs_configuration: 'Configuração PBS',
  backup: 'Backup',
  restore: 'Restauração',
  verify: 'Verificação',
  retention: 'Retenção',
  catalog_export: 'Exportação do catálogo',
  recovery_drill: 'Ensaio de recuperação',
  administrator: 'Administrador',
  backup_operator: 'Operador de backup',
  restore_operator: 'Operador de restauração',
  viewer: 'Visualizador',
  sftp: 'SFTP',
  local: 'Local (mesmo host)',
  smb: 'SMB',
  google_drive: 'Google Drive',
  s3: 'S3',
  pbs: 'Proxmox Backup Server',
};
export const humanLabel = (value: string) => labels[value] ?? value;
