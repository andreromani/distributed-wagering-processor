# Evidências de validação

[Voltar ao README](../README.md)

Este documento separa execuções automatizadas de demonstrações manuais. Logs completos em `logs/` são artefatos locais ignorados pelo Git e podem não existir em um clone limpo. As decisões atuais estão em [ARCHITECTURE.md](../ARCHITECTURE.md); versões anteriores e a cronologia de desenvolvimento permanecem no Git.

## Estratégia de testes

Testes unitários com `bun:test` cobrem Money, Wallet, regras financeiras e idempotência. Integrações usam PostgreSQL e LocalStack reais, bancos/filas exclusivos e verificam constraints, migrations reversíveis, atomicidade, inbox, retry/DLQ, outbox e referências pendentes. Mocks não substituem essas provas de infraestrutura.

A suíte distribuída executa três processos reais da mesma aplicação. Barreiras desabilitadas por padrão sincronizam pontos específicos de commit, ACK e publicação sem substituir as garantias SQL. Os cenários conferem saldo materializado e saldo reconstruído pelo ledger. Os [comandos de execução](../README.md#testes-e-resultados) e a [operação dos recursos exclusivos](OPERATIONS.md#recursos-das-execuções-distribuídas) estão separados das evidências abaixo.

## Resultados finais

| Validação | Resultado final | Origem |
| --- | --- | --- |
| Suíte convencional | 517 testes aprovados, zero falhas, 2.102 assertions, 19 arquivos; duração de 134,54 segundos no ambiente de desenvolvimento | Última execução da suíte convencional na validação final do projeto. |
| Build, typecheck e lint | Aprovados | Validação final do projeto; verificações anteriores também registradas no histórico Git. |
| Suíte distribuída | Nove PASS, zero FAIL, 1.208 assertions; três instâncias reais simultâneas | RunId `11b97e9e-b8b9-4846-ac6f-611c4044927a`; `logs/distributed-tests/<runId>/summary.json` e `logs/barrier-fix-distributed.log`. |

Os resultados pertencem às execuções de validação, sem nova execução de suítes nesta revisão. A duração convencional descreve uma execução no ambiente de desenvolvimento, não um benchmark de carga. O resumo distribuído registra `normalConfigurationRestored=true`.

## Resultados históricos

| Execução | Resultado | Escopo e evidência local |
| --- | --- | --- |
| Convencional anterior | 507 testes, zero falhas, 2.041 assertions, 18 arquivos | `logs/final-test-run.log`; anterior à inclusão dos testes novos do escritor atômico e substituída pelo resultado final de 517 testes. |
| Direcionada de arquivos/barreiras | 14 testes, zero falhas, 73 assertions | logs/barrier-fix-targeted-tests.log; inclui casos novos de retry, erro permanente, ordem dos escritores e limpeza. Sobrepõe parte da cobertura anterior. |

Essas execuções são parcialmente sobrepostas e não devem ser somadas como uma suíte única. A execução direcionada validou a correção antes da execução convencional final. Build, typecheck, lint, lint adicional dos scripts e Prettier também passaram na validação da correção.

## Cenários distribuídos

| Cenário | Prova | Resultado |
| --- | --- | --- |
| A | Três repetições de 50 duplicatas concorrentes entre instâncias | PASS |
| B | BET concorrentes de 80.00 sobre 100.00 e hot wallet | PASS |
| C | Wallets distintas avançam enquanto outra permanece bloqueada | PASS |
| F | REFUND entregue antes da BET e resolvido por worker | PASS |
| E1 | Dois publishers mantêm claims SQL simultâneos distintos | PASS |
| E2 | SIGKILL após confirmação do broker e antes dos metadados da outbox | PASS |
| D | SIGKILL após commit financeiro e antes do ACK; replay em outra instância | PASS |
| G | Recuperação de mensagem, outbox e referência após restart | PASS |
| H | Reconciliação das 16 wallets e conferência dos 83 eventos publicados/observados | PASS |

O resumo confirmou completed=true, normalConfigurationRestored=true e pending=[]. A inspeção posterior confirmou app-1/app-2/app-3 healthy, liveness/readiness nas portas 3001–3003, banco/filas normais e ausência de DISTRIBUTED_TEST_* nos containers. PostgreSQL e LocalStack permaneceram preservados. As definições dos cenários e suas assertions não foram reduzidas.

Uma execução anterior, `6af8ea27-5881-4879-a81b-c086a68a233a`, passou A/B/C/F e falhou em E1 após 571 assertions por EPERM no rename de control.json. D/E2/G/H ficaram pendentes, com configuração normal restaurada. O escritor passou a usar temporário exclusivo, fila por caminho e retry limitado, mantendo substituição atômica. A origem exata do bloqueio de filesystem não foi atribuída conclusivamente. A repetição final aprovou os nove cenários. Detalhes do mecanismo atual: [barreiras de teste e escritor atômico](../ARCHITECTURE.md#barreiras-de-teste-e-escritor-atômico).

## Histórico técnico relevante

- **Migrations e snapshots:** testes reais verificaram run/revert/run da fundação e da migration incremental em bancos exclusivos. O downgrade incremental perde snapshots adicionais de REJECTED/FAILED, preservando saldo, status e ledger; o da fundação remove tabelas/dados. Nunca foi usado como limpeza do banco principal.
- **Corridas de identidade/inbox:** regressões coordenadas reproduziram commit entre buscas por chave/identidade externa e conflito de inbox durante a consulta final. A implementação revalida chave/hash, usa o receipt validado e faz rollback completo antes de nova tentativa por constraint. A falha intermitente inicial de duplicatas não teve stack integral preservado e não foi atribuída conclusivamente a essa janela; a janela foi reproduzida separadamente e corrigida.
- **Compatibilidade histórica da inbox:** antes da introdução do consumer, receipts usavam somente hash financeiro. O algoritmo atual inclui idempotencyKey. Hashes antigos não são reinterpretados nem migrados automaticamente; eventual replay desses receipts recebe INBOX_CONFLICT e exige avaliação explícita, sem apagar dados.
- **Startup Linux:** uma exportação Git foi extraída em filesystem nativo de container com umask 022, sem bind mount Windows ou chmod manual do hook. init-queues.sh estava 100755/LF; healthcheck.sh, 100644/LF, pois é chamado por sh. LocalStack isolado criou três filas exclusivas e `/tmp/queues-ready`; duas reexecuções diretas preservaram exatamente as três filas. Build da imagem, migrations em PostgreSQL exclusivo e readiness 200/abertura HTTP 201 passaram. A prova isolou startup, sem substituir os cenários de três processos. Registros locais: `logs/stage1311-linux.json`, `logs/stage1311-linux-build-errors.log` e `logs/stage1311-linux-app.log`.
- **Timeouts SQS/readiness:** execuções agregadas anteriores registraram AbortError, timeout e readiness 503 apesar de containers healthy. Houve observação de CPU elevada e processos awslocal zumbis; healthcheck foi simplificado para curl/grep e init foi habilitado. Repetições posteriores passaram, mas também houve falha intermediária após o ajuste: a causa dos timeouts segue inconclusiva. Logs locais incluem `logs/stage11-tests-first.log` e `logs/stage11-tests-second-failure.log`.
- **Orçamentos administrativos:** timeout no catálogo TypeORM impediu startup, e o gate de migrations bloqueou corretamente as APIs. O CLI recebeu orçamento próprio para catálogo/DDL, sem ampliar timeouts financeiros. Probes de shutdown/restart tiveram sincronização ajustada; validação posterior comprovou drenagem antes de fechar recursos, ACK com inbox confirmada e recuperação consistente.
- **EPERM Windows/Docker:** a falha ocorreu no rename dos controles, sem evidência de erro financeiro ou identificação conclusiva do handle responsável. O escritor atual trata EPERM/EBUSY/EACCES com até oito tentativas, serializa escritores por caminho e preserva JSON ativo/erros de limpeza. Os 14 testes direcionados cobrem sucesso após falha transitória, esgotamento, erro permanente, ordenação e limpeza; a execução distribuída final passou sem temporários .next remanescentes.

Referências Git existentes: `a11264c` (concorrência/crash distribuídos), `2f44fc8` (correções da auditoria, incluindo startup Linux) e `002b5cd` (controles distribuídos e entrega). Esses commits preservam o texto cronológico anterior e seus resultados intermediários; não representam novas execuções desta revisão.

## Demonstração manual

Resultados da demonstração manual HTTP/Postman e SQS nas três instâncias, separados das provas automatizadas. Os IDs locais dos testes não foram incorporados à collection/environment.

| Cenário manual | Resultado observado |
| --- | --- |
| Fluxo financeiro principal | Saldo inicial e final 1000.00 BRL, com operações e reconciliação consistentes. |
| Replay entre instâncias | Resultado original reproduzido sem débito/crédito duplicado. |
| Ledger paginado | Páginas com 2, 2 e 1 registros; cursor de outra wallet rejeitado. |
| Referência fora de ordem | REFUND resolvido automaticamente após BET no cenário com cerca de oito segundos; no cenário de cerca de 36 segundos, o REFUND já havia sido rejeitado por esgotamento. |
| BET 50.00 por SQS em wallet de 1000.00 | Duas mensagens distintas na inbox, uma transação financeira, um débito, dois eventos publicados (WagerTransactionProcessed e WalletBalanceChanged) e saldo final 950.00. Eventos/lançamento de OPENING não estão incluídos nesses números incrementais. |
| Envelope inválido | Encaminhamento à DLQ na primeira tentativa. |
| Distribuição e diagnóstico | Processamento e publicação entre três instâncias, com logs correlacionados e inspeção de inbox, outbox, DLQ, reconciliação e métricas. |

Os testes manuais não atualizam contagens das suítes automatizadas.

## Limites das evidências

- A aprovação distribuída não é benchmark de throughput nem garante ausência de toda falha futura de infraestrutura.
- O envio at-least-once pode gerar duplicatas; eventId estável não substitui deduplicação persistente no consumidor.
- Os timeouts históricos intermitentes de SQS/readiness continuam com causa inconclusiva, mesmo com execuções posteriores aprovadas.
- Reiniciar aplicações preserva estado no banco/broker existente; recriar o LocalStack local pode perder filas e mensagens.
- Procedimentos de limpeza dos recursos retidos estão no [guia operacional](OPERATIONS.md#limpeza-segura).
