# Dokploy: capacidades verificadas

Consulta em 29/10/2026; versão observada no servidor: **0.29.13**. O conector deve detectar a versão/capacidades da conexão, sem extrapolar esta análise a qualquer instalação.

| Necessidade         | Caminho                                                                                 | Limite                                                                                                                   |
| ------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Projetos/aplicações | API pública, incluindo `project.all`, consultas de aplicação/Compose/PostgreSQL         | API Key no cofre; projetar campos públicos, sem devolver ambiente/credenciais brutos                                     |
| Backup de banco     | `backup.create`, `backup.one`, `backup.manualBackupPostgres`                            | Configuração nativa de destino S3; evitar duas agendas; verificar artefato além do retorno da chamada                    |
| Backup de volume    | `volumeBackups.list/create/one/runManually`                                             | Named volumes, não bind mounts; consistência depende de escrita/pausa                                                    |
| Restore com logs    | Subscriptions `restoreBackupWithLogs` / `restoreVolumeBackupWithLogs` na versão 0.29.13 | Código declara `openapi.enabled: false`; não expor como REST público estável. Usar agente seguro ou administração nativa |
| Aplicação inteira   | Composição de componentes explicitamente selecionados                                   | Backup do próprio Dokploy não comprova backup de todos os bancos/volumes das aplicações                                  |

Não migrar mounts, alterar o banco administrativo ou parar aplicações de produção durante descoberta. NAS/Drive não são destinos diretos do mecanismo S3 nativo. Um HTTP aceito ou um upload não substitui verificação e ensaio de recuperação.

Fontes oficiais: [API](https://docs.dokploy.com/docs/api), [bancos](https://docs.dokploy.com/docs/core/databases/backups), [volumes](https://docs.dokploy.com/docs/core/volume-backups), [backup.ts v0.29.13](https://github.com/Dokploy/dokploy/blob/v0.29.13/apps/dokploy/server/api/routers/backup.ts), [volume-backups.ts v0.29.13](https://github.com/Dokploy/dokploy/blob/v0.29.13/apps/dokploy/server/api/routers/volume-backups.ts).
