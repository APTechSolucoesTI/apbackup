# APBackup — proteção e recuperação de recursos

Este diretório contém contratos TypeScript/Zod, catálogo privado PostgreSQL,
autenticação/autorização, console web TanStack Start, coordenador e agente Linux.
Em **Sistemas**, pastas persistentes vinculam planos existentes de aplicação,
bancos e arquivos de um mesmo servidor. Cada componente mostra agenda, retenção,
execução e resultados por destino do próprio plano. O botão **Backup agora**
solicita uma vez cada plano distinto da pasta, em uma transação auditada e
idempotente. Configurar pastas exige a autorização administrativa e segundo fator
já usados pelo catálogo; criar uma pasta não cria planos nem ativa agendas.
Dependências externas e planos compartilhados devem ser descritos no escopo.
O catálogo original de perfis continua em **Catálogo avançado de perfis**.
Oferece backup lógico PostgreSQL 17 e retorno independente de containers,
grupos Swarm aprovados, volumes e arquivos, com cópias Restic verificadas por
destino. PBS/Proxmox permanecem fora do produto.

**Instalação no Dokploy, preparação do agente/NAS e recuperação do próprio painel:**
[guia de instalação](docs/installation.md). Agendas e destinos só entram em operação
após configuração explícita; não há credenciais nem backups reais pré-carregados.

### Produção APTech

O fluxo é `GitHub main → Dokploy → docker-compose.yml`, na raiz deste repositório.
O painel usa `https://apbackup.aptechinfo.app.br`, publicado pelo túnel existente.
Um webhook exclusivo do repositório aciona o Compose do APBackup; seu endereço
privado e as variáveis de ambiente ficam fora do código. A terminação HTTPS é
feita pela Cloudflare, e o Dokploy encaminha o serviço web na porta interna3000.

Na instalação assistida, servidor/agente e destinos local/NAS são cadastrados e
verificados. Isso não significa que os sistemas existentes já tenham backups:
após o primeiro login, configure o autenticador em **Segurança**, selecione os
recursos, crie os planos e valide uma captura manual antes de habilitar as agendas.
O padrão diário é03:00 America/Sao_Paulo, retenção7dias com proteções do último
ponto verificado e de operações em andamento. O agente atualiza o inventário
em segundo plano; falha nessa atualização não interrompe a comunicação dos jobs.

O plano captura uma vez em um repositório local e replica esse mesmo ponto para
destinos independentes (S3, SMB/SFTP, diretório montado aprovado ou Drive autorizado).
O painel mostra os resultados por destino, repete uma cópia que falhou e permite
escolher uma cópia verificada para restaurar. A retenção automática após o backup
diário preserva o último ponto verificado e pontos em uso; também pode ser acionada
manualmente. Renovar o acesso ao storage preserva a senha Restic e o histórico.

Restaurar banco cria um **novo banco**; retornar aplicação é outra ação e não
restaura seu banco. Containers simples e grupos Swarm aprovados retornam imagem,
configuração e arquivos próprios. Recursos compartilhados, scripts de migração,
Compose e dependências do Supabase exigem a revisão indicada pelo produto.

## Requisitos e execução local

- Node.js 24 LTS, pnpm 10.17.1 e Docker com imagens Linux.
- Execute os comandos abaixo a partir de `backup-platform/`.
- A porta **5549** deve estar livre para o PostgreSQL local. O console usa a origem
  `AUTH_BASE_URL` (exemplo: `http://127.0.0.1:4320`). Ambos escutam somente em loopback.

```powershell
pnpm install --frozen-lockfile
Copy-Item .env.example .env
# Configure AUTH_SECRET aleatório com pelo menos 32 caracteres antes de iniciar.
pnpm dev:services
pnpm db:migrate
pnpm dev
```

`pnpm dev` inicia o console em `AUTH_BASE_URL`; `/login` é o acesso. Nenhuma conta padrão
é criada: use o bootstrap local descrito abaixo. `pnpm dev:catalog` preserva o harness
de saúde em `PORT` (não execute os dois serviços na mesma porta). `/health` desse harness é um
**harness local de banco**, sem interface e sem rotas de dados. Falha de acesso ao catálogo
retorna HTTP 503 sem revelar conexão ou credenciais. Execute `pnpm db:migrate` explicitamente
antes de iniciar: `dev`/watch só leem o catálogo e não aplicam rascunhos de migrations ao
reiniciar. O console consulta o mesmo catálogo por rotas autenticadas no servidor.

O Compose usa o projeto exclusivo `apbackup-platform-dev`, database `apbackup_dev` e volume
`apbackup-platform-dev_apbackup_catalog_dev`. A senha de exemplo só atende ao uso local;
mantenha `.env` fora do Git e altere as duas variáveis de forma consistente se a trocar.
Não aponte esta base a um banco compartilhado ou de produção.

Parar e reiniciar o banco preserva o volume:

```powershell
docker compose --env-file .env -f compose.dev.yaml stop
pnpm dev:services
```

Não use `down -v` se quiser preservar o catálogo de desenvolvimento. O projeto não altera
outros containers existentes.

## Pacotes e interfaces

- `@apbackup/contracts`: único entrypoint para código que possa executar no browser.
  Exporta schemas e tipos derivados de recursos, dependências, versões de perfis,
  manifesto v1, operações, escopo de restauração, agenda, retenção, destinos e capacidades.
  Objetos públicos são estritos; manifestos exigem os componentes obrigatórios, hashes,
  caminhos relativos seguros e configuração cifrada com referência de custódia externa.
- `@apbackup/db`: **somente servidor**. Exporta
  `createDatabase(url: string): PlatformDatabase`, `migrate(db): Promise<void>` e `schema`.
  A conexão oferece `orm` (Drizzle), `pool` (pg) e `close()`. Não importe este pacote no browser.
- `@apbackup/db/schema`: tabelas e tipos de linha/inserção derivados de Drizzle.

As tabelas são a base das organizações, usuários/membros, origens/agentes/conexões,
recursos/dependências/perfis, destinos/repositórios/capacidades, planos/agendas/retenção,
execuções/etapas/tentativas/leases/eventos, pontos/componentes/manifestos/evidências,
pedidos/confirmações/aprovações/resultados de restauração, pontos de retorno, auditoria,
exportações e kits de recuperação. Não há dados iniciais fictícios.

Identidade tem uma única fonte: `users`, com e-mail normalizado e único;
`organization_memberships` inicia com papel `viewer`. Sessões, contas e MFA foram adicionadas
na migration 0004, sem duplicar `users`.

IDs são UUIDs, instantes usam `timestamptz` e atualizações mantêm `updated_at` no banco.
Chaves compostas impedem referências entre organizações. O catálogo é banco privado,
sem Data API pública: **todas as rotas devem aplicar autorização e escopo de organização
em todas as consultas de servidor**. FKs não impedem leitura indevida por uma conexão SQL
privilegiada; esta base não afirma oferecer autorização de rotas ou RLS.

`secret_references` é separado dos DTOs públicos e reserva envelopes cifrados e referências
de chave externa. Cifragem, gestão de chaves e autorização são entregas posteriores;
esta migration não cria credenciais. Constraints rejeitam chaves de segredo reconhecidas
e URLs autenticadas em JSON público como defesa adicional. Elas não substituem validação
de fronteira e redação de logs, nem identificam qualquer sequência arbitrária como segredo.

## Migrations

`packages/db/migrations/0001_platform.sql` é a migration inicial. A migration não insere
destinos nem dispara jobs. Planos/agendas começam desabilitados; destinos começam em
`aguardando_configuracao`; caminhos e referências de credencial ficam nulos até configuração.
Os padrões de agenda são `03:00`, `America/Sao_Paulo`; retenção de 7 dias, evidências de
90 dias e proteção do último ponto verificado.

`0002_catalog_integrity.sql` vincula responsáveis humanos de pedidos, confirmações e
aprovações ao membership da mesma organização. Memberships referenciados são registros
históricos: exclusão física e reassociação de sua chave ficam bloqueadas; revogação de
acesso deve preservar essa atribuição histórica na implementação de autorização. Atores
system/agent exigirão modelagem explícita, sem aceitar UUID humano arbitrário.
`0003_execution_event_integrity.sql` garante que eventos com etapa apontem à etapa da
própria execução; eventos sem etapa continuam permitidos. As duas migrations preservam
dados e não corrigem atribuições inválidas silenciosamente: constraints novas rejeitam
catálogos com referências históricas inválidas, exigindo diagnóstico antes de prosseguir.

O executor aplica arquivos `NNNN_nome.sql` diretamente da pasta, em ordem, dentro de
transação com advisory lock. Registra SHA-256 em `platform_migrations`, aceita repetição
e inicialização concorrente e rejeita alteração de migration já aplicada. **Crie uma nova
migration para mudar o banco** e atualize o schema Drizzle correspondente. SQL também mantém
as funções/checks de timezone, evidências públicas e triggers de timestamp; preserve-os
ao preparar mudanças futuras. Não há execução automática contra ambientes remotos.

## Verificação

```powershell
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm test:integration
pnpm test:integration -- catalog
pnpm test:e2e
pnpm build
```

- `test`: contratos Zod (manifesto completo/incompleto, credenciais, identidade,
  agenda, destino e perfil).
- `test:integration`: cria PostgreSQL 17 descartável, publica uma porta aleatória somente
  em loopback, usa database `apbackup_test_<hex>` e remove apenas seu container/volume ao
  terminar. Testa persistência em nova conexão, FKs, unicidade, migrations concorrentes e
  repetidas, checksum, defaults, timestamps, identidade e saúde real de banco.
- O harness **recusa `DATABASE_URL` ou `TEST_DATABASE_URL` herdados**. Não carregue `.env`
  para testes; não há reset de banco arbitrário. O próprio teste também valida host e
  prefixo antes de conectar. Requer Docker; não usa SQLite ou banco em memória.
- `test:e2e`: Playwright exercita HTTP no serviço real com PostgreSQL descartável, sem
  mocks de persistência. Requer Chromium (`pnpm exec playwright install chromium`): cobre
  login/MFA/recuperação, autorização, navegação, tabelas e teclado em três viewports e dois temas.
- `build`: compila contratos/banco, copia migrations para `dist/db/migrations` e gera
  cliente/servidor Nitro em `apps/web/.output`. O harness compilado pode executar com
  `node --env-file=.env dist/db/src/dev.js`; migration compilada:
  `node --env-file=.env dist/db/src/cli.js`.

O inventário editável e os fluxos de proteção de recursos estão disponíveis.
Um catálogo ou destino cadastrado não comprova cobertura nem recuperação.

## Console operacional (Task 3)

React 19, TanStack Start/Router, Query 5, Vite 8/Nitro, Tailwind 4 e shadcn New York.
Rotas: cobertura, servidores, sistemas, recursos, destinos, planos, execuções, configurações
e segurança da conta. Esta última permite configurar/verificar TOTP, guardar códigos de
recuperação, confirmar a identidade por cinco minutos, renovar códigos e desativar o fator
com confirmação. As operações sensíveis continuam autorizadas no servidor.

`GET /api/console/catalog` valida filtros, paginação e whitelist de ordenação. Count e página
usam o mesmo snapshot e cada consulta valida membership/organização. DTOs públicos omitem
credenciais. Tema e colunas usam armazenamento local por usuário/organização/listagem;
senhas, sessões e códigos MFA nunca são persistidos nesse armazenamento.

`0005_listing_collation.sql` cria `apbackup_pt_numeric`, uma collation ICU pt-BR com comparação
numérica, aplicada antes da paginação. Requer suporte ICU (presente no PostgreSQL 17 oficial
de desenvolvimento/testes). Não altera registros nem índices existentes.

O tema em `apps/web/src/styles.css` preserva os tokens fornecidos e usa `primary-strong`
para ações compactas com contraste AA. Fontes Inter/JetBrains Mono possuem fallback do sistema.
O build verifica os arquivos públicos com `pnpm test:client-boundary`, recusando assinaturas
de configuração privilegiada, tabelas auth e drivers de banco. Avisos de diretivas `use client`
do Radix no build servidor não ativam RSC; este console usa React convencional.

Para executar a aplicação compilada, configure o ambiente do servidor e use
`pnpm --filter @apbackup/web start`. Console e `dev:auth` usam a mesma origem: execute apenas
um deles por vez. Nenhum deles aplica migrations automaticamente.

## Configuração e onboarding (Task 4)

1. Provisione o administrador real pela CLI local e entre no console.
2. Em **Segurança da conta**, configure o autenticador, guarde os códigos de recuperação
   e confirme a senha e o segundo fator. A prova vale cinco minutos e é exigida no servidor.
3. Cadastre servidores e recursos; identifique dependências compartilhadas explicitamente.
4. Cadastre um sistema com seus recursos, versão do conector, consistência e escopos planejados.
   Cada edição acrescenta uma versão imutável. Execuções mantêm a versão selecionada na criação.
5. Cadastre destinos com protocolo, mecanismo, pasta dedicada e credencial quando disponíveis.
   Protocolo, mecanismo e pasta podem ficar vazios enquanto aguardam preparação. Credenciais
   são cifradas no cofre e nunca retornam na leitura. Não há ping ou acesso remoto ao salvar.
6. Crie o plano com destinos obrigatórios/opcionais, retenção e agenda; deixe desabilitado
   enquanto a configuração estiver pendente. Habilitar exige destinos obrigatórios completos
   e avaliação real do conector para a revisão atual. Cadastro ativo não certifica cobertura.

Arquivar preserva histórico e evidências; referências ativas impedem arquivamento inseguro.
Restaurar um plano ou destino arquivado não o habilita automaticamente. Edições concorrentes
são rejeitadas por versão de atualização, sem sobrescrever silenciosamente o trabalho anterior.

Importação explícita: `pnpm inventory:import` recebe JSON por stdin com `baseURL` (origem
loopback do console), `organizationId`, `email`, `password`, `code` TOTP, `server` contendo
`name/externalIdentity/hostname`, e `destination` contendo `name/host`. Para o inventário
aprovado, informe os endereços 192.168.3.106 e 192.168.3.52 nesses campos; o produto não os
codifica como origem fixa. O comando autentica e reautentica o administrador pela mesma API,
cria apenas configurações pendentes e pode ser repetido sem substituir cadastros divergentes.
Não inventa protocolo, pasta, credencial ou capacidade. Forneça a entrada por canal local seguro,
sem argumentos de senha, histórico de shell ou arquivos permanentes. Não há importação automática.

`0006_configuration.sql` adiciona arquivamento, protocolo/mecanismo a definir, versões de
perfil imutáveis e vínculo imutável da versão na execução. Execuções antigas sem esse vínculo
não recebem uma versão inferida a partir do plano atual. `0007_destination_capability_revision.sql`
vincula avaliações de conector à revisão exata da configuração do destino; trocar conexão,
credencial ou mecanismo exige avaliação nova. Indisponibilidade transitória não é desabilitação.

API: `/api/configuration/{servers|resources|systems|destinations|plans}` usa POST para criar,
`/{id}` GET/POST para ler/editar e `/{id}/{archive|restore}` POST para arquivar/restaurar.
Mutações existentes exigem `expectedUpdatedAt`. `/options` oferece busca limitada e contagem;
`/coverage/{serverId}` calcula cobertura somente com manifesto íntegro, componentes obrigatórios
e evidência individual de destino. Nenhuma tela recebe o segredo da credencial ou o envelope cifrado.

# Autenticação e administração local (Task 2)

O servidor de autenticação é independente do harness de saúde do catálogo. Execute
`pnpm db:migrate` explicitamente antes de `pnpm dev:auth`; iniciar o serviço não
aplica SQL. `AUTH_BASE_URL` define a origem confiável e a porta local (4311 por
padrão). `DATABASE_URL`, `AUTH_SECRET`, `VAULT_KEY_BASE64` e
`VAULT_KEY_REFERENCE` ficam somente no ambiente do servidor. Não use prefixos
`VITE_` para essas variáveis. `AUTH_SECRET` precisa ter pelo menos 32 caracteres
aleatórios; a chave do cofre contém 32 bytes aleatórios codificados em base64.

Não há cadastro público, envio de e-mail ou conta padrão. O primeiro administrador
é provisionado com `pnpm auth:bootstrap`, recebendo pela entrada padrão um objeto
JSON com `email`, `password` (12–128 caracteres), `name` e `organizationName`
(estes dois últimos são opcionais). A senha não é aceita como argumento e nunca é
impressa. Forneça o JSON por um canal local seguro, evitando histórico de shell e
arquivos permanentes com credenciais. A CLI exige PostgreSQL em loopback e usa a
mesma tabela `users`, contas Better Auth e `organization_memberships` do produto.
Repetir o bootstrap preserva as credenciais do administrador existente. Uma
identidade preexistente sem associação administrativa ativa é recusada, sem
elevação implícita de privilégios.

Após login em `/api/auth/sign-in/email`, configure TOTP por
`/api/auth/two-factor/enable` (senha obrigatória). O fator só se torna ativo depois
de `/api/auth/two-factor/verify-totp` confirmar um código do autenticador. Guarde
os dez códigos de recuperação fornecidos no cadastro em custódia independente.
Login posterior exige o desafio TOTP ou um código de recuperação de uso único.
Os retornos com TOTP/códigos são material secreto: nunca registre essas respostas.

`POST /api/reauthenticate` recebe senha e `code` TOTP **ou** `recoveryCode`, com
sessão e origem válidas. A prova fica no banco, vinculada à sessão, por no máximo
cinco minutos. Login sozinho não cria essa prova. Restauração, segredos e
configuração exigem senha e segundo fator recentes. Desativar MFA, revelar seu
URI, regenerar códigos e alterar senha também exigem a prova recente. O endpoint
`GET /api/permissions/{read|backup|restore|secrets|configure}` informa a permissão
da sessão atual; os endpoints de domínio carregam o recurso e aplicam `authorize`
com a organização real do recurso.

`GET /api/session` devolve o principal sanitizado. `x-organization-id` escolhe uma
organização, mas o backend consulta a associação ativa e o papel no banco em toda
requisição. Sem o cabeçalho, usa a primeira associação ativa. Papéis: administrator
(todas as permissões), backup_operator (leitura/backup), restore_operator
(leitura/restauração) e viewer (leitura). Revogar associação preenche `revoked_at`;
não exclua associações que fazem parte do histórico de restauração.

Para recuperação emergencial **local**, `pnpm auth:recover` recebe por stdin
`email` e uma nova `password`. Ele troca o hash, revoga todas as sessões, remove o
fator antigo e registra auditoria por organização, preservando a identidade e suas
associações. Configure TOTP novamente antes de operações sensíveis. Esta CLI não
é importada nem exposta por nenhuma rota pública e depende da custódia privilegiada
do host e do acesso ao banco local.

O cofre AES-256-GCM autentica organização, referência e finalidade, além da versão
e identificação da chave. Grave somente o envelope cifrado em `secret_references`.
Guarde `VAULT_KEY_BASE64` e `AUTH_SECRET` fora do catálogo e inclua ambos no plano
de recuperação externa: perder o primeiro impede ler credenciais; perder o segundo
invalida sessões e impede decifrar fatores/códigos Better Auth antigos. `.env` é
ignorado pelo Git; em Windows, restrinja sua ACL à conta de execução e custódia.
Não rotacione chaves sem migração/reconciliação das credenciais cifradas.

As tabelas `auth_*` são privadas no PostgreSQL, sem grants a `PUBLIC`; não há Data
API nem conexão do navegador ao banco. A autorização de organização é aplicada no
servidor, não por uma chave Supabase ou por esconder controles. Produção exige
HTTPS, cookies Secure/HttpOnly e origem explícita; não se confia em host/protocolo/IP
encaminhados pelo cliente. Limites persistidos em banco protegem login, MFA e
reautenticação sem depender desses cabeçalhos. As verificações MFA compartilham
cinco tentativas por minuto por usuário, entre fatores, sessões e desafios de
login, incluindo reautenticação no servidor. A identidade vem da sessão consultada
no banco ou do cookie de desafio assinado e ainda válido no catálogo. Tentativas
anônimas inválidas usam um limite separado, sem consumir o orçamento de usuários.

Os handlers em `apps/web/src/routes/api/auth/$.ts` estão registrados no TanStack Start.
O console usa a mesma API funcional; `dev:auth` preserva o servidor HTTP isolado para
diagnóstico. Integração cobre PostgreSQL descartável, HTTP real, CLI, TOTP, códigos de
recuperação, revogação, cookies, permissões, cofre e redaction. Não há agendas ou
operações de infraestrutura ativadas por autenticação.

## Coordenador e agente Linux (bloco de execução)

`pnpm coordinator` inicia polling durável da fila, com claims de 60 segundos, heartbeat e reconciliação. `COORDINATOR_SCHEDULES=enabled` permite consumir somente agendas já habilitadas; o padrão é `disabled`. Esse processo nunca aplica migrations. A agenda usa o timezone de cada plano; após vários dias offline gera apenas a ocorrência mais recente. Execução manual usa `POST /api/runtime/execute` com `{planId,idempotencyKey}`, sessão autorizada e organização derivada da sessão. O mesmo par pode ser repetido sem duplicar a execução.

O produtor executa captura e restauração reais para planos individuais PostgreSQL 17 criados no fluxo `/postgresql`. Outros perfis continuam com preflight `inspect`; sem agente ou conector compatível ficam em `exige_intervencao`, sem criar ponto protegido. O fluxo PostgreSQL preserva IDs de comando, versão histórica, leases, fencing e reconciliação existentes.

A API disponível no servidor TanStack Start inclui:

- `POST /api/agents/invitations` com `{serverId}`: administrador com senha/MFA recentes recebe uma inscrição de uso único, válida por 10 minutos; não registrar a resposta em logs.
- `POST /api/agents/enroll` com `{enrollment,externalIdentity}`: troca por `{agentId,organizationId,identity}`; o banco guarda apenas hashes dos segredos.
- `POST /api/agents/poll`, `/authorize` e `/results`: identidade Bearer de agente, restrita à sua organização e servidor, recusada após revogação.
- `POST /api/agents/{id}/revoke`: administrador com confirmação recente.
- `GET /api/runtime/executions/{id}`: estado e últimos 100 eventos sanitizados, somente da organização da sessão.

### Preparação local do host Linux

Instalar Node 24 em `/usr/local/bin/node`, pnpm 10.17.1 e uma cópia do projeto em `/opt/apbackup`; executar `pnpm install --frozen-lockfile` incluindo `tsx`. Criar o usuário dedicado `apbackup-agent`. O console não recebe Docker socket, SSH nem privilégios do host. Nenhuma porta de entrada é necessária no agente: todas as conexões saem por HTTPS com validação normal de certificado.

Preparar `/etc/apbackup` sem symlinks e com permissão de escrita somente do administrador. O arquivo `agent.json` deve pertencer ao usuário do agente e ter modo `0600`; journal e staging devem ser diretórios privados `0700`, em filesystem Linux local e persistente, por exemplo `/var/lib/apbackup/journal` e `/var/lib/apbackup/artifacts`. Não colocar esses diretórios em bind mount Windows, pasta temporária compartilhada ou volume efêmero. Cada recurso recebe um `root` absoluto autorizado, sem symlinks em seus ancestrais, e uma lista explícita de unidades systemd. O diretório de staging precisa existir antes da captura.

Para inscrever, enviar por **stdin** a `pnpm agent -- --enroll` um JSON contendo `baseURL` HTTPS, `enrollment`, `externalIdentity`, `journalDirectory`, `artifactRoot` e `resources`. `resources` mapeia cada UUID a `{root,units:[]}`. Definir `AGENT_CONFIG` para o caminho a publicar. A identidade é gravada com fsync e publicação atômica sem substituir arquivo já existente. Não usar segredo em argumento de processo, histórico do shell ou arquivo versionado. Depois iniciar `pnpm agent` com `AGENT_CONFIG` configurado.

A unidade `deploy/agent/apbackup-agent.service` usa esse usuário dedicado, filesystem protegido e escrita restrita a `/var/lib/apbackup`; o operador deve instalar o arquivo com modo `0644`, conferir caminhos locais e somente então habilitar o serviço. A verificação automatizada cobre a análise estática da unidade; não houve instalação ou inicialização de serviço systemd real nesta máquina.

**Controle de serviços:** `service_pause`/`service_resume` exigem unidades explicitamente permitidas e autorização vigente do plano/lease no servidor. Pausa só é aceita para unidade inicialmente ativa. O usuário dedicado não ganha autorização global de systemd. Até o administrador configurar uma regra Polkit ou helper local revisado que permita apenas `start`/`stop` dessas unidades, esse controle fica indisponível e falha de forma segura. Nunca conceder gerenciamento global, sudo genérico ou acesso a Docker para resolver essa configuração. Capturas que não precisam pausar serviços não dependem desse privilégio.

O watchdog tenta reativar somente unidades registradas como pausadas; roda na inicialização, falhas de captura/conexão, expiração da janela de pausa e encerramento. `ExecStopPost` repete a recuperação após morte do processo. Falha de retomada mantém o registro de pausa e adiciona incidente durável; requer ação operacional, sem alegar retomada bem-sucedida.

### Reconciliação e remoção

Não apagar o journal para tentar novamente. Cada comando registra aceitação, maior fence, início e resultado com fsync. Depois de um início sem resultado, a resposta é `unknown` e o efeito não é repetido. Resultado conhecido pode ser republicado após perda de resposta. Um journal corrompido falha fechado; apenas a última linha incompleta pode ser truncada. Reinscrição não autoriza repetir efeito incerto: o catálogo mantém os comandos pendentes do recurso. Preserve catálogo, journal e artefatos para investigação.

Para remover um agente, primeiro revogar sua identidade na API administrativa, depois parar/desabilitar sua unidade no host, conferir os registros de retomada dos serviços e guardar o journal/artefatos conforme a política operacional. Só depois remover software e configuração local. Revogação e remoção não apagam automaticamente evidências ou comandos incertos.

Validação local: `pnpm test:integration -- scheduler leases reconciliation coordinator-process agent-auth agent-journal tool-safety runtime-api catalog` usa PostgreSQL descartável real. `pnpm test:linux-runtime` usa a imagem Node fixada e `/tmp` interno Linux, sem rede, para journal, permissões, symlinks, artefatos, timeout e sinais. Não certifica integrações externas ou um serviço systemd em execução.

### Correções da revisão do runtime

Jobs bloqueados por efeito desconhecido agora ficam estacionados em `waiting`, com execução em `exige_intervencao`, motivo e evento duráveis. Recursos temporariamente ocupados usam `retry_after` com espera crescente de 5 a 60 segundos; os demais jobs continuam elegíveis. `dispatch_attempts` registra cada claim, inclusive o que precisou aguardar. Esta mudança exige a migration `0009_queue_retry_fairness.sql`; iniciar o coordenador continua sem aplicar SQL automaticamente.

No Linux, a exclusão mútua do journal usa `/usr/bin/flock` (util-linux) sobre um descritor mantido aberto pelo agente. O kernel libera o bloqueio quando o processo morre. O arquivo `process.lock` permanece no diretório: nenhum fluxo Linux lê PID ou remove esse arquivo para recuperar uma falha. Não apagar/trocar esse inode enquanto houver processos acessando o journal. Ausência ou permissões inseguras do executável causam recusa de inicialização. Em Windows, usado somente para contratos locais, continua a criação exclusiva sem recuperação automática de lock após falha; a certificação de agente e recuperação concorrente permanece Linux.

O journal registra separadamente cada par recurso/unidade. Retomar uma unidade não remove a pausa das outras; o watchdog percorre todas as unidades pendentes após reabrir o journal e mantém os incidentes com a unidade correspondente.

## PostgreSQL individual (R1)

Aplique `pnpm db:migrate` explicitamente para incluir `0010_postgresql_resource.sql`. No console, cadastre um servidor, confirme senha/MFA em Segurança e abra **PostgreSQL**. Guarde a conexão, teste/descubra os bancos, selecione um deles, cadastre um destino local Restic e crie o plano. Execute manualmente ou marque a agenda diária; agendas só são consumidas com `COORDINATOR_SCHEDULES=enabled`. Nenhuma instalação ativa uma agenda automaticamente.

O runtime certificado é **PostgreSQL 17 → pg_dump 17 → pg_restore 17 → PostgreSQL 17**, Restic **0.19.1**, Node 24, Linux amd64. Outras versões são bloqueadas. Um recurso protege um banco inteiro ou schemas explicitamente selecionados; não implica cobertura de roles globais, arquivos ou storage. Identificadores suportados usam até 63 letras ASCII/números/sublinhado, começando por letra ou sublinhado. O banco compartilhado `postgres` pode ser fonte; o destino de restore deve ser novo e não reservado. A descoberta usa somente consultas de leitura e não precisa de um perfil prévio. Conexões e vínculos banco/versão são imutáveis: uma nova origem requer outro cadastro.

Configure `POSTGRES_ALLOWED_HOSTS` no servidor com os hosts exatos aprovados. O agente deve incluir o mesmo host em `postgresql.allowedHosts`. Use TLS com certificado verificado para origens remotas; `disable` é aceito apenas para loopback. Certificados privados precisam ser confiáveis no Node do servidor/agente e no bundle `/etc/ssl/certs/ca-certificates.crt` do runtime. A conta PostgreSQL precisa de CONNECT e leitura suficiente para `pg_dump`; para restauração também CREATEDB e criação dos objetos necessários. Não conceda superusuário apenas por conveniência.

Para bancos PostgreSQL 17 já executados em Docker no host do agente, o instalador administrativo local pode provisionar uma conexão com `transport: "docker_exec"`, `container` com o nome exato e `username`, sem senha nem referência fictícia de segredo. Configure `postgresql.dockerSocketPath` e `postgresql.allowedDockerContainers` na configuração privada do agente. A aplicação web recusa cadastro/descoberta Docker: não acessa o socket do agente. Este transporte usa o socket Unix PostgreSQL dentro do container permitido, vincula o nome ao ID completo e executa somente `psql`, `pg_dump` e `pg_restore`, com prazo de processo, saída limitada e cancelamento dos próprios backends identificados. O container deve fornecer esses utilitários e `timeout` (GNU ou BusyBox). O transporte TCP conserva sua lista de hosts e a exigência de TLS remoto.

O dump lógico binário é transmitido para o staging privado do agente, verificado por `pg_restore --list`, protegido com Restic e lido novamente para conferir o hash. A volta usa somente banco novo, com nova autorização antes de `CREATE DATABASE`; banco de origem e vizinhos existentes são recusados como destino. Um banco Supabase compartilhado deve ser identificado como compartilhado e protegido inteiro quando houver dependências entre schemas. O snapshot não inclui roles globais nem arquivos externos. `node scripts/postgresql-docker-runtime.mjs` testa captura/Restic/retorno de cinco schemas compartilhados, preservação de origem/vizinho, colisões e cancelamento em PostgreSQL 17 descartável. Requer a imagem `apbackup-postgresql-runtime:17` construída pelo comando `pnpm test:postgresql`.

Além dos campos normais da inscrição do agente, adicione:

```json
{
  "postgresql": {
    "allowedHosts": ["db.example.internal"],
    "repositoryRoot": "/var/lib/apbackup/repositories"
  },
  "resources": {}
}
```

Essa é uma extensão do JSON de inscrição, não o arquivo completo. As três raízes locais (journal, artifactRoot e repositoryRoot) devem existir como diretórios Linux privados 0700, sem symlinks. Não é necessário cadastrar manualmente cada banco na política do agente. A pasta escolhida na interface é uma chave relativa simples sob `repositoryRoot`. Cada destino deve usar uma pasta exclusiva; preserve o volume do repositório em reinícios. O destino **local** fica no mesmo host e não oferece redundância contra perda do host.

Para construir o runtime de ferramentas e agente reproduzível:

```powershell
pnpm build:agent
docker build -f apps/agent/Dockerfile.postgresql -t apbackup-postgresql-runtime:17 .
```

A imagem fixa as bases Node/PostgreSQL e verifica o SHA256 oficial do Restic. Monte configuração inscrita 0600 e os diretórios privados persistentes; a imagem inicia somente o agente, sem servidor PostgreSQL. Alternativamente, o agente existente pode executar em Linux com os executáveis aprovados nos caminhos fixos do Dockerfile. Nenhum segredo entra no bundle. O agente resolve somente os segredos do comando armazenado, identidade não revogada, lease/fence atual e versão histórica via HTTPS; o endpoint não é um leitor genérico de cofre. `PGPASSFILE` temporário é privado e removido ao terminar; argumentos e logs não contêm a senha.

Um ponto só é publicado após `pg_dump`, leitura do catálogo do archive, snapshot Restic real, `restic check --read-data`, recuperação do arquivo e comparação SHA256. Catálogo persiste manifesto canônico, componentes, ID real do repositório/snapshot, bytes e evidência de verificação. Não há poda automática nesta etapa; retenção fica para R4. Preserve catálogo, senha Restic e chave externa do cofre em custódia independente. Não altere a senha de um repositório existente pelo formulário.

**Restaurar em banco novo** verifica o snapshot/hash e exige nome ausente antes de `CREATE DATABASE`. Origem e bancos vizinhos não são substituídos. Objetos restaurados pertencem ao usuário da conexão; owners/grants originais não são reaplicados. O restore usa transação e registra contagens de tabelas. Após criação ou restore incerto, o journal responde `unknown`, preserva a reserva e requer inspeção operacional; nunca apague o journal ou repita cegamente. Erros podem deixar o banco novo para investigação e não o removem automaticamente.

Provas descartáveis: `pnpm test:postgresql` constrói a imagem e percorre APIs/coordenador/agente reais, backup/Restic/restore, comparando dados e sequência e preservando origem/vizinho. `pnpm test:e2e postgresql.spec.ts` valida o fluxo no navegador com agente Linux e TLS de fixture confiável (sem desabilitar verificação), recarga e três viewports. Ambos gerenciam apenas PostgreSQL/arquivos de teste e não aceitam banco de produção.

## Docker e arquivos individuais (R2)

`0011_docker_resources.sql` acrescenta descoberta autenticada e vínculos imutáveis à mesma fila, catálogo e armazenamento Restic. **Docker e arquivos** permite selecionar volume, diretório aprovado ou container simples. O agente atualiza o catálogo a cada 30 segundos; o console nunca recebe o socket Docker. Arquivos são capturados sem pausa, com consistência de falha; dados de banco detectados são recusados e devem usar a ação lógica independente.

O agente Linux pode usar o mesmo bundle/runtime de R1 e recebe, na configuração inscrita, este bloco adicional:

```json
{
  "docker": {
    "socketPath": "/var/run/docker.sock",
    "helperImage": "sha256:<ID exato da imagem helper instalada e aprovada>",
    "repositoryRoot": "/var/lib/apbackup/repositories",
    "directories": { "anexos": "/srv/aplicacao/anexos" }
  }
}
```

`helperImage` deve ser o ID SHA256 completo de uma imagem Linux aprovada contendo `/usr/bin/tar` GNU e `/usr/local/bin/node` 24 (o fixture usa a base Node fixada no Dockerfile R1). O administrador instala/confere essa imagem antes de habilitar o agente. `directories` mapeia nomes simples a raízes **do host do daemon**, privadas e estáveis, sem symlinks e administradas por pessoa confiável. Não inclua uma raiz de produção sem autorizar sua leitura e a criação de subdiretórios de restauração. Journal, staging e repositório continuam privados e persistentes. Acesso ao socket Docker é equivalente a privilégio de administrador do host: conceda somente ao agente dedicado revisado; não ao console ou ao helper de extração. A unidade systemd restrita anterior não ganha esse acesso automaticamente.

Um backup de aplicação inclui `image.tar` da imagem exata, `config.enc` com AES-256-GCM/chave derivada da senha Restic e um archive por mount próprio. Restic cifra todo o conjunto. O manifesto registra cada componente obrigatório e seu hash. O agente verifica snapshot/read-data e recupera/compara todos os arquivos antes de publicar um ponto. A configuração e o ambiente nunca entram no catálogo público, nos comandos ou resultados. Preserve senha Restic, chave do cofre e catálogo fora do host.

**Voltar aplicação sem banco** exige digitar o nome exato e trava o ID do container alvo. Recupera os arquivos em volumes novos, carrega a imagem arquivada, prepara um substituto, para/renomeia somente o alvo, inicia o substituto com portas/configuração históricas e aguarda seu healthcheck quando existir. O original e seus volumes permanecem preservados, parados, para retorno manual. Sem healthcheck a evidência é somente “em execução”; não é certificação funcional da aplicação. Banco, DNS, redes especiais e integrações externas são ações independentes. Nenhum restore lógico é disparado por esta ação.

Volumes individuais são restaurados somente em nomes ausentes; diretórios somente em subdiretório novo de sua raiz aprovada. Não há merge, sobrescrita de vizinhos nem ligação automática à aplicação nesses dois modos. A comparação abrange bytes, nomes, diretórios, UID/GID e permissões Unix básicas. Links, arquivos especiais, bits especiais, nomes incompatíveis com ustar, ACL/xattrs e camada gravável de container não são suportados; a captura recusa links/especiais em vez de apresentar cobertura completa. Camada gravável alterada, mounts compartilhados/ambíguos, Swarm, runtimes privilegiados/especiais e mounts fora das raízes aprovadas bloqueiam o retorno simples. Swarm/Dokploy exigem o adaptador nativo específico.

Uma falha depois de criar destino/carregar imagem/iniciar troca fica `unknown`, mantém a reserva e não é repetida. Preserve o journal e confira labels `apbackup.restore=<commandId>`, o container original `apbackup-old-<executionId>` e os destinos novos antes de intervir. O prazo total é uma hora; o coordenador renova a posse durante transferências. Não há rollback cego, poda ou limpeza automática de artefatos nesta etapa.

`pnpm test:docker` usa Docker/arquivos/banco descartáveis reais, incluindo volume novo, diretório controlado, retorno de aplicação com HTTP/healthcheck, colisões e resultado tardio. `pnpm test:e2e docker.spec.ts` usa navegador e agente Linux via HTTPS confiável, retorno histórico, recarga e três viewports. Nenhum desses comandos aceita banco externo nem acessa origens de produção.

## Dokploy, grupo Swarm conhecido e schemas (R3)

`0012_dokploy_schema_resources.sql` acrescenta escopo de schemas e acompanhamento persistente de execuções nativas Dokploy. Configure `DOKPLOY_ALLOWED_ORIGINS` com origens HTTPS exatas, separadas por vírgula. Em **Dokploy**, cadastre servidor/origem/API Key; a chave é cifrada e nunca reapresentada. A descoberta usa a API pública com `x-api-key`, detecta versão e projeta somente projetos/ambientes/recursos/mounts públicos. Operações nativas são admitidas somente no contrato revisado **0.29.13**; outra versão permite inspeção mas exige revisão antes de mutação. Não há proxy de comandos nem acesso ao banco administrativo Dokploy.

Selecione uma configuração S3 nativa já existente para executar backup lógico PostgreSQL ou volume nomeado de aplicação/Compose. Sua agenda e retenção continuam no Dokploy; o APBackup não cria uma segunda agenda. Configuração que pausa a aplicação (`turnOff`) é recusada. As execuções são persistidas antes da chamada, deduplicadas e observadas pelo coordenador. Um objeto novo/não vazio no prefixo fica **artefato observado**, sem afirmar integridade independente ou criar ponto Restic verificado. Chamadas perdidas ficam incertas, reservadas e não são reenviadas; a observação pode registrar artefato posterior. Lista nativa limitada a 100 objetos exige prefixo menor. Retenção/notificações nativas continuam sob a configuração do provedor. NAS/Drive não são destinos nativos S3. Restore com logs é uma subscription sem REST público nesta versão: use o painel nativo ou as ações independentes do agente, sem endpoints inventados.

Em **Docker e arquivos → Grupo Swarm**, selecione 1–3 IDs reais, seus papéis explícitos (frontend/API/worker), chaves de ambiente atuais a preservar e confirme a revisão de startup sem migrações. A configuração é vinculada ao perfil imutável pelo painel; não exige editar JSON por aplicação. Nomes não determinam papéis. Para APBling conhecido, `apbling-api-gmhp0o` é frontend, `apbling-frontend-oxmtt4` é API e `apbling-worker-eb3agu` é worker; selecione os IDs efetivamente descobertos, não copie nomes como política do produto. O banco `integrador_bling_v2` e Redis são independentes desta ação.

O agente exige manager acessível, todas as réplicas no seu nó e mounts próprios do grupo; compartilhamento API/worker dentro do grupo é admitido e capturado uma só vez. São recusados vizinhos proprietários, raízes não aprovadas, camada gravável externa, bancos detectados, mounts ambíguos, secrets/configs Swarm externos e comandos de startup com migrações. Entrypoints internos e compatibilidade entre versões exigem revisão operacional por versão: não são inferidos. O conjunto inclui a imagem arquivada de cada serviço, configuração cifrada e arquivos dos mounts. Usa a fila, contexto autorizado, fence, journal, prazo, Restic e verificação de hashes existentes.

**Antes de Voltar grupo sem banco**, desative redeploy automático, webhooks e outros reconciliadores externos do grupo no Dokploy/pipeline; confira tarefas em andamento e confirme esse preparo na interface. Digite o nome exato do grupo. O retorno restaura/compara arquivos em volumes novos, carrega as imagens históricas e atualiza somente os IDs confirmados com controle de versão. Mantém valores atuais das chaves marcadas (conexão/chaves de banco/Redis); as demais configurações voltam ao histórico. Verifica imagem, ambiente esperado, mounts efetivos, execução e healthchecks configurados. Sem healthcheck, o resultado comprova execução, não todo o comportamento de negócio. Fonte/vizinhos permanecem intactos; não há restore de banco, fila ou DNS. Atualização parcial/incerta requer inspeção manual, sem replay ou rollback cego.

O retorno por agente altera o estado desejado **Swarm**, sem reescrever o estado desejado **Dokploy**. Antes de reativar qualquer redeploy, alinhe no painel nativo as imagens históricas, ambiente e novos mounts, ou prepare explicitamente o retorno ao estado anterior. Um deploy Git posterior pode substituir o retorno se esse passo for ignorado. O preparo é confirmado pelo operador; não há garantia automática de bloquear controladores externos. Conjuntos Compose explícitos também podem proteger e retornar imagens, configuração cifrada e mounts próprios: consulte [semântica, omissões e limites de Compose](docs/compose-recovery.md). Não há reconstrução universal de compose.yaml ou de infraestrutura externa. Startups com migrations exigem um `restoreStartup` sem migrações explicitamente revisado, tanto em Compose quanto em Swarm.

Em **PostgreSQL**, descubra schemas da conexão real, marque o escopo e crie um plano independente. `pg_dump --schema` captura os schemas selecionados e a evidência fica vinculada ao mesmo escopo. Dependências externas catalogadas (incluindo auth/storage/vault, extensões e papéis de políticas) bloqueiam a captura parcial automática; SQL dinâmico e integrações externas exigem revisão manual. Schemas gerenciados Supabase não são selecionáveis como um schema comum. Uma API Key REST Supabase não substitui credenciais/permissões PostgreSQL. É possível escolher backup do banco inteiro, inclusive fonte `postgres`, para recuperação isolada; extensão/roles globais ainda precisam existir no destino compatível. Todo restore continua criando **banco novo**, sem limpar ou sobrescrever schemas do compartilhado. Owners/grants originais não são reaplicados.

Provas curtas: `pnpm test:postgresql -- --schemas` usa dois schemas reais, retorna somente o selecionado em banco novo, compara dados/vizinho e bloqueia FK externa. `pnpm test:swarm` usa um daemon Docker-in-Docker descartável, sem iniciar Swarm no host, e compara imagens/config/arquivos, conexão atual e vizinho após retorno real. O teste requer a imagem de runtime PostgreSQL já construída e baixa `docker:27-dind`. `pnpm test:integration tests/integration/dokploy-api.test.ts tests/integration/postgresql-api.test.ts` verifica os contratos HTTP públicos com fixture de provedor, sigilo, autorização, escopo e observação nativa sem transformar aceitação em sucesso. `pnpm test:e2e integrations-smoke.spec.ts` verifica os novos formulários no navegador com fixtures das APIs; não certifica um servidor Dokploy real. Credenciais externas e ensaios das aplicações reais são a próxima etapa operacional após deploy autorizado.
