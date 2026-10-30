# Conjunto Compose revisado

Este adaptador protege um conjunto explícito de até três containers de aplicação
(interface, API e worker). Não interpreta nem reescreve um compose.yaml ou o estado
desejado do Dokploy. PostgreSQL, Redis e outros serviços externos continuam sendo
dependências independentes.

O vínculo usa `kind: "compose"`, `identity` igual ao label exato do projeto e
`containers` com `name`, `service`, `role`, `preserveEnvironmentKeys` e
`startupReviewed: true`. O ID opcional é informativo. Cada execução resolve nome,
projeto e serviço, captura os IDs atuais e rejeita mudança concorrente de identidade,
imagem, configuração, mounts ou rede. Um redeploy legítimo entre execuções não
invalida o nome estável do vínculo.

`restoreStartup: { command: string[], entrypoint?: string[] }` é um comando de
retorno explicitamente revisado, em argumentos separados. A mesma opção existe
para serviços Swarm. Sem substituição segura, startup com migrations é recusado.
Scripts de pacote e entrypoints internos precisam ser revisados pelo administrador;
o adaptador não consegue provar que código arbitrário não altera bancos. Nunca
marque a revisão sem verificar o comando efetivo e a compatibilidade de esquema.

A captura não para os containers. Inclui imagens por SHA256, configuração cifrada
com AES-GCM e scrypt, volumes nomeados compartilhados somente dentro do conjunto
e binds exatos previamente autorizados no agente. Arquivos de configuração somente
leitura podem ter outros leitores somente leitura. Compartilhamento com qualquer
escritor externo, dados ativos de banco, runtime especial, links/arquivos especiais
e alterações independentes da camada gravável são recusados. Alterações de mtime
de diretórios ancestrais causadas por mountpoints só são aceitas quando permissões
e UID/GID continuam iguais aos da imagem exata. Diretórios ancestrais novos precisam
ser diretórios reais; qualquer alteração de arquivo independente continua recusada.
Se um bind auxiliar removido impedir a API de arquivo do daemon, somente a consulta
de metadados de diretórios pode usar Node `fs.lstat` dentro do container vivo,
sem shell, com o usuário original, preloads e cache de compilação desativados,
e resposta numérica limitada. Probes da imagem parada continuam usando a API.
O init injetado pelo daemon só é admitido com `HostConfig.Init: true`, preservado
no retorno. O helper fixado roda sem rede,
com raiz e origem somente leitura; conserva apenas `DAC_READ_SEARCH` para ler
arquivos privados sem alterar suas permissões.

`emptyReadOnlyMounts` permite listar destinos auxiliares explicitamente descartáveis,
por exemplo `/data/metrics`. Somente binds aprovados e somente leitura podem ser
listados. Seus bytes **não são capturados**: a seleção nos pontos de recuperação
registra a omissão, e o retorno cria um volume vazio separado. Nunca use essa opção
para nginx.conf, anexos, uploads, segredos ou outro conteúdo necessário ao sistema.

`ephemeralPaths` registra caches gerados que serão descartados e recriados pelo
startup. A lista é restrita a `.next/cache`, `/root/.cache/prisma`,
`/root/.cache/checkpoint-nodejs` e `/tmp/node-compile-cache`; diretórios de código,
configuração e `.next/server` não podem ser omitidos. Os demais caminhos alterados
na camada gravável continuam bloqueando a captura.

O retorno exige confirmação do projeto, `replaceContainer`, bloqueio operacional
de redeploys e IDs/nomes atuais enviados pelo servidor em `targetContainers`.
Webhooks, agendas e deploys do Dokploy devem ficar pausados durante a operação.
O daemon não fornece transação CAS para grupos Compose: a conferência de identidade
detecta alterações concorrentes observáveis, mas não substitui esse bloqueio externo.

Todos os dados são extraídos em volumes novos e conferidos por hash, caminho,
UID/GID e permissões. Binds de arquivo voltam como subpath de arquivo em volume
novo, preservando o destino e a propriedade somente leitura. Volumes compartilhados
do conjunto continuam compartilhados. As variáveis listadas usam valores atuais;
as demais usam a configuração histórica. O grupo original é parado e renomeado,
sem apagar containers nem dados. Os substitutos só são considerados prontos após
todos permanecerem em execução e passarem nos healthchecks disponíveis. Erro após
uma mutação exige inspeção dos alvos rotulados; não há repetição automática nem
rollback destrutivo.

O subpath de arquivos restaurados também é preservado no inventário/configuração.
Novas capturas leem o arquivo dentro do volume, em vez de transformar a raiz do
volume em diretório no destino de um arquivo. Mistura de raiz e subpath no mesmo
volume é recusada. O ensaio descartável inclui retorno, nova captura do grupo
restaurado e segundo retorno com bytes/permissões e healthchecks verificados.

Redes bridge locais e overlays Swarm attachable existentes podem ser reutilizadas
somente com ID e configuração histórica idênticos. Endereços fixos de bridge, links
e opções especiais por endpoint são recusados. Docker preenche `IPAMConfig` com IPs
operacionais de overlays, e a API pública não expõe a distinção interna da origem.
Por isso, `docker.dynamicOverlayNetworks` na configuração privada do agente deve
mapear explicitamente o nome ao ID exato de cada overlay revisado para usar DNS e
IPs dinâmicos no retorno. Somente nesses IDs são descartados os IPs operacionais
coincidentes com o endereço atual; chaves IPAM adicionais são recusadas. Nunca
autorize uma rede cujos consumidores dependam de IPs fixos. Este adaptador não cria redes em host vazio:
a infraestrutura e dependências devem ser reconstruídas explicitamente antes do
retorno. Os aliases de serviço são preservados; IDs transitórios são removidos.

Depois do retorno, alinhe imagens, ambiente e volumes no Dokploy antes de reativar
deploys. Os originais retidos ainda têm labels Compose: não execute `compose down`
ou limpeza genérica supondo que sejam descartáveis. Verifique-os e remova-os somente
em uma operação administrativa separada e autorizada.

Prova isolada: `node scripts/compose-runtime.mjs` usa Docker 27 DinD descartável,
sem tocar no daemon de produção. Requer `node:24.21.0-bookworm-slim`,
`docker:27-dind` e a imagem local `apbackup-postgresql-runtime:17` já construída.
