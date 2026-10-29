# Instalação e recuperação do APBackup

O painel, o coordenador e seu catálogo privado são serviços separados. Somente o
agente confiável acessa o Docker da origem. PBS/Proxmox são administrados fora do
APBackup. Não existe conta inicial, cadastro público ou senha padrão.

## Painel no Linux / Dokploy

Use Docker Compose v2, imagens Linux amd64 e uma origem HTTPS com certificado
válido. O projeto Compose está em `deploy/compose.yaml`, com contexto de build na
raiz `backup-platform/`. No Dokploy, cadastre esse Compose e direcione o domínio
para o serviço **web**, porta interna **3000**. Web e coordenador não recebem o
socket Docker. PostgreSQL não publica porta no host.

Prepare a configuração **no Linux**, sem sobrescrever instalações anteriores:

```sh
node scripts/prepare-install.mjs --origin https://backup.example.com --output .env.production
docker compose --env-file .env.production -f deploy/compose.yaml build web agent
docker compose --env-file .env.production -f deploy/compose.yaml up -d postgres migrate web coordinator
```

O helper gera senhas e chaves aleatórias, grava o arquivo privado `0600` e não
imprime os valores. No Dokploy, transfira essas variáveis para a configuração
protegida do serviço. **Guarde uma cópia cifrada fora da VPS antes de cadastrar
credenciais**. Não regenere `VAULT_KEY_BASE64` nem `AUTH_SECRET` numa reinstalação
que reutilize o catálogo. Não versione `.env.production`.

`POSTGRES_ALLOWED_HOSTS` deve listar exatamente os endereços dos bancos que serão
descobertos. `DOKPLOY_ALLOWED_ORIGINS` recebe a origem HTTPS exata da API Dokploy.
Ausência de configuração bloqueia o acesso. O endereço e a porta do PostgreSQL
precisam ser acessíveis pelo agente; nomes internos de uma rede Docker precisam
ser resolvidos nessa rede ou substituídos por um endpoint privado aprovado.

O Compose aguarda o banco e aplica as migrations antes do painel/coordenador.
`COORDINATOR_SCHEDULES=disabled` mantém agendas desligadas na instalação. Após
conferir agentes e destinos, habilite essa variável e ative os planos desejados.
O padrão de plano é **03:00, America/Sao_Paulo**, com retenção de **7 dias**.

## Primeiro administrador

Crie uma conta real por stdin, usando um arquivo temporário privado contendo
`{"email":"seu-email","password":"senha escolhida","name":"Seu nome"}`:

```sh
docker compose --env-file .env.production -f deploy/compose.yaml --profile administration run --rm -T administrator < /caminho/privado/administrador.json
```

Remova somente esse arquivo temporário após confirmar o login. O serviço de
administração compartilha a rede do PostgreSQL e usa `ADMIN_DATABASE_URL` em
loopback; não é uma API pública. Em **Segurança**, habilite o segundo fator e
guarde os códigos de recuperação fora do servidor. Configuração de credenciais e
restauração exigem senha e segundo fator recentes. Recuperação administrativa
local usa o mesmo serviço com `node /app/runtime/administrator.mjs --stdin --recover`.

## Agente da origem 192.168.3.106

Prepare diretórios privados Linux, persistentes, sem symlinks, com modo `0700`:
`/etc/apbackup`, `/var/lib/apbackup/journal`, `/var/lib/apbackup/artifacts` e
`/var/lib/apbackup/repositories`. Docker socket equivale a administração do host;
somente o agente confiável recebe essa permissão.

Use `deploy/agent/enrollment.example.json` como referência. Substitua a origem
HTTPS, a inscrição de uso único e o ID local da imagem auxiliar. Não envie esse
JSON preenchido ao Git. A inscrição é obtida por administrador autenticado e
com MFA recente em `POST /api/agents/invitations {serverId}`; vence em 10 minutos.
O agente troca essa inscrição por sua própria identidade, guardada em arquivo
privado. A instalação assistida fará essa troca; a credencial não deve ir em
argumentos nem no histórico do shell.

A imagem auxiliar precisa fornecer Node e GNU tar. Prepare a imagem fixa e use
o ID local retornado, não uma tag mutável:

```sh
docker pull node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
docker image inspect --format '{{.Id}}' node:24.21.0-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
```

Para inscrever pela imagem do agente, monte `/etc/apbackup` com escrita somente
nessa execução e passe o JSON pelo stdin:

```sh
docker run --rm -i --network host --mount type=bind,source=/etc/apbackup,target=/etc/apbackup apbackup-agent:local /app/agent.mjs --enroll < /caminho/privado/inscricao.json
docker compose --env-file .env.production -f deploy/compose.yaml --profile agents up -d agent
```

Depois de inscrito, `/etc/apbackup` fica somente leitura no serviço. O agente
usa HTTPS de saída, sem porta de entrada. As listas `postgresql.allowedHosts` e
`repositories.allowedHosts` são independentes. Para copiar ao NAS fornecido,
aprove `192.168.3.52` na segunda lista. Diretórios arbitrários do host precisam de
aprovação explícita e de bind mounts com o mesmo caminho no agente; não monte a
raiz do host. Volumes Docker são acessados pelos auxiliares confinados.

## Storage da empresa

Referência pública pronta: `deploy/destinations/company-storage.json`.

- Servidor: `192.168.3.52`, SMB, porta 445.
- Compartilhamento: `01 - Backup Remotos`.
- Diretório informado: `Sistemas`.
- Repositório dedicado proposto: `Sistemas/APBackup`.

O acesso fornecido foi guardado com proteção DPAPI fora do repositório. Em
29/10/2026, a imagem Linux do agente executou um teste real com Restic/Rclone:
gravação cifrada, verificação completa e recuperação de bytes idênticos em uma
subpasta `Validacao-UUID` exclusiva. Somente esse repositório temporário foi
removido após o teste; a pasta `Sistemas/APBackup` está preparada. Isso comprova
leitura e gravação a partir do ambiente de desenvolvimento, mas não o acesso
de rede do agente no 3.106 ou capacidade para o volume real de dados. Na instalação, transferir a
credencial diretamente ao cofre do painel, criar uma senha Restic independente e
avaliar o destino pelo agente. O JSON público permanece aguardando configuração
e não contém senha. Não crie um repositório na raiz de um compartilhamento.

Um plano captura uma vez em um repositório local privado e copia o mesmo ponto
para os destinos adicionais. Cada cópia é verificada separadamente. Falha no NAS
não invalida a cópia local, mas exige atenção até existir uma cópia fora da origem.
O restore permite selecionar uma cópia verificada disponível.

## Catálogo e chaves também precisam de backup

O catálogo guarda inventário, pontos, histórico e credenciais cifradas. A chave
`VAULT_KEY_BASE64` e as senhas Restic precisam de custódia externa independente:
um dump do catálogo sozinho não permite decifrá-las. Conserve também a
configuração privada do agente e as configurações do Compose/Dokploy.

Para exportação administrativa local, use diretório privado e o `pg_dump` da
própria imagem PostgreSQL:

```sh
umask 077
docker compose --env-file .env.production -f deploy/compose.yaml exec -T postgres pg_dump -U apbackup -d apbackup -Fc > /caminho/privado/catalogo.dump
```

Esse dump contém material privado. Inclua-o em uma captura cifrada para outro
servidor e valide a cópia antes de removê-lo. Configure também um plano periódico
PostgreSQL do catálogo quando o endpoint privado do agente estiver preparado.
Na perda do painel: recuperar configuração/chaves externas, preparar um catálogo
**novo e vazio**, restaurar o dump com `pg_restore`, aplicar migrations e iniciar
web/coordenador. Nunca restaurar esse dump sobre o Supabase dos sistemas.

## Operação e aceite

No painel: cadastrar servidor/agente, descobrir recursos, escolher bancos e
containers, configurar destino local e NAS, criar planos e executar um backup
manual antes de ativar agendas. Inspecionar resultados por destino e os eventos.

Banco e aplicação são restaurações independentes. Banco recupera em **novo banco**;
troca da conexão/aplicação para ele é uma etapa explícita do operador. Retorno de
aplicação inclui imagem/configuração e mounts próprios, sem restaurar banco.
Para Swarm, confirme os papéis, variáveis atuais que serão preservadas e comando
de inicialização. Desabilite redeploys externos antes de retornar e alinhe a
configuração no Dokploy antes de reativá-los. Scripts de inicialização que migram
banco precisam de revisão antes de qualquer retorno.

A retenção usa Restic, preserva o último ponto verificado e pontos em uso. Não
apaga containers originais ou volumes de origem. Objetos `apbackup-old-…` e novos
volumes de retorno são preservados para conferência. Remova-os individualmente
somente após validar o resultado e confirmar que nenhum serviço os utiliza.
Uma operação `exige_intervencao` deve ser investigada pelos seus eventos e journal;
não apague locks/journal nem repita um efeito incerto às cegas.

Antes do uso definitivo, executar o ensaio já combinado em clones: backup manual,
quebrar um arquivo/processo, retornar aplicação, restaurar o banco separadamente e
conferir os dados. Não há validação automática de todos os comandos próprios dos
sistemas nem restauração universal de Compose/Supabase.
