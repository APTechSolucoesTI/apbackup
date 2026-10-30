# Sistemas reais do 3.106

Escopo autorizado: configurar APMail, Expertex, Integrador NW produção, APFiscal, APBling, APTicket e APPintura, com bancos e arquivos, NAS e Google Drive, diariamente às 03:00 de São Paulo, retenção de sete dias. Não executar restauração sobre sistemas reais nesta configuração.

1. Completar OAuth do Drive e validar conta, espaço e repositório de forma privada.
2. Estender o adaptador Docker para conjuntos Compose conhecidos: imagens exatas, configuração criptografada e mounts pertencentes ao conjunto; restaurar preservando originais e sem executar migrações contra bancos reais. Manter rejeição de bancos ativos, mounts compartilhados com terceiros e configurações não suportadas. Testar captura/retorno isolados e limites.
3. Adicionar transporte PostgreSQL pelo Docker local, restrito aos containers de banco autorizados, sem relaxar TLS das conexões remotas. Dump consistente e retorno somente em banco novo. Testar transporte e rejeições. Migration 0015 reservada se necessária.
4. Criar agrupamento persistente por sistema e vínculo com planos (migration 0014). Tela usa componentes e tokens existentes, componentes Aplicação/Banco/Arquivos e pontos de recuperação; backup manual de todos os componentes sem duplicar planos compartilhados.
5. Cadastrar fontes reais, nomes claros, destinos e planos por bootstrap administrativo local auditado; Supabase compartilhado deve ser identificado como compartilhado e nunca prometer retorno parcial sem suas dependências.
6. Verificar lint, tipos, testes relevantes e build; revisar diff. Publicar pelo GitHub/Dokploy autorizado.
7. Conforme orientação posterior do usuário, não disparar primeira rodada manual dos sistemas reais: ele próprio acompanhará essa execução. Deixar agendamento diário das 03:00 habilitado e backup manual disponível; execução manual não muda o agendamento. Verificar configuração e interface em desktop/tablet/mobile, preservando a distinção entre repositório validado e backup real ainda não executado.

Responsabilidades independentes: adaptador Compose; transporte PostgreSQL local; agrupamento/integração e configuração operacional. Nenhuma credencial vai para código ou logs. Migrações antigas são imutáveis. Sem mudanças no PBS.

Decisão de execução: o Supabase real contém pg_cron vinculado ao banco postgres e seis segredos Vault. O dump completo será preservado com os arquivos de Storage/Functions e configuração/chave de recuperação em cópias criptografadas. Pontos com extensões vinculadas ao cluster são identificados e o retorno genérico em banco novo é bloqueado antes de criar qualquer banco. Sua recuperação exige uma instalação Supabase compatível; não prometer restauração parcial automática dos schemas. Os bancos de aplicação independentes mantêm retorno em banco novo.
