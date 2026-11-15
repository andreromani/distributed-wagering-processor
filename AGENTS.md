# AGENTS.md

## Escopo e fonte de verdade

- Leia integralmente `CHALLENGE.md` antes de implementar qualquer funcionalidade e consulte as seções pertinentes durante o trabalho.
- Implemente somente o escopo solicitado em cada etapa. Não antecipe funcionalidades, dependências ou infraestrutura sem necessidade da etapa.
- O desafio prevalece sobre convenções do template. Registre interpretações, decisões, trade-offs e limitações em `ARCHITECTURE.md`; mantenha setup e comandos em `README.md`.

## Stack e ferramentas

- Use Bun 1.x como runtime, package manager e test runner, inclusive em produção e CI. Testes devem usar `bun test` e APIs de `bun:test`, não Vitest ou Jest.
- Use TypeScript em modo strict. Evite `any`, supressões e desativações de verificações; justifique exceções necessárias para integração com frameworks.
- Preserve ESM e imports relativos com extensão `.js`. Não introduza CommonJS nem use `__dirname`.
- Use NestJS, TypeORM e PostgreSQL. TypeORM é a escolha deste projeto, aceita pelo desafio; não adote outro ORM. Documente o mapeamento de Money e a estratégia transacional.
- Use AWS SQS com LocalStack para desenvolvimento local e Docker Compose para orquestração e testes de integração.
- Consulte a documentação da versão instalada do NestJS antes de adotar APIs: https://docs.nestjs.com/llms.txt. Avalie integrações oficiais, como `@nestjs/typeorm`, antes de criar integrações próprias; verifique se preservam as garantias do desafio.
- Migrations devem ser versionadas, reversíveis e verificadas em ambos os sentidos. Não use sincronização automática de schema como substituto.

## Arquitetura e modelagem

- Aplique Clean Architecture com organização por módulos de negócio e separação de domínio, aplicação, infraestrutura e entradas HTTP/SQS.
- Mantenha o domínio independente de NestJS, ORM e transporte. Use portas nas fronteiras necessárias, sem abstrações, interfaces ou camadas sem propósito concreto.
- HTTP e SQS devem reutilizar o mesmo caso de uso financeiro.
- Encapsule invariantes e transições em classes; use construtores privados/protegidos e factories estáticas. `rehydrate` reconstrói estado persistido sem reaplicar regras de transição.
- Estados PROCESSED, REJECTED e FAILED são terminais. Documente transições válidas e códigos de falha estáveis.

## Dinheiro e integridade financeira

- Nunca use `number`, `float` ou `double` para valores monetários ou cálculos financeiros. Use representação decimal exata ou inteiros exatos, sem conversão intermediária para ponto flutuante.
- Money deve ser imutável, independente do ORM, recebido e serializado como string decimal com escala fixa de duas casas e moeda ISO-4217. Rejeite entradas inválidas, notação científica, excesso de casas e valores negativos nos contratos de entrada.
- Preserve o modelo multi-moeda e rejeite operações entre moedas distintas, mesmo que a execução inicial use apenas BRL.
- Nunca permita saldo negativo, lost update, crédito/débito duplicado ou perda de eventos confirmados.
- Toda mudança de saldo corresponde a um lançamento imutável no ledger e vice-versa. Não atualize nem exclua lançamentos. LOSS e rejeições não geram lançamentos.
- Saldo inicial positivo exige OPENING interno e crédito no ledger na mesma transação SQL. OPENING não pode entrar por HTTP ou SQS.
- Garanta no schema unicidade de wallet por player/moeda, unicidade financeira, não-negatividade e imutabilidade do ledger, conforme o desafio; validação somente em código é insuficiente.
- Reconciliação compara saldo materializado ao reconstruído pelo ledger. Sinalize divergências na resposta, logs e métricas; não as corrija silenciosamente.

## Concorrência, idempotência e atomicidade

- A unidade de concorrência é walletId. A solução deve funcionar com pelo menos três processos simultâneos e permitir paralelismo entre wallets distintas.
- Use controle de concorrência transacional no PostgreSQL, com estratégia e retries limitados documentados. Não use lock global nem read/calculate/update desprotegido.
- Idempotência deve ser persistente, protegida por constraints e compartilhada entre HTTP e SQS. Memória e deduplicação FIFO não são garantias suficientes.
- O header Idempotency-Key é obrigatório no HTTP. Calcule payloadHash sobre JSON canônico dos campos de negócio, excluindo metadados de transporte; documente o algoritmo.
- Mesma chave e payload reproduzem o resultado original, incluindo o saldo observado; payload divergente é conflito.
- Transação financeira, saldo, ledger, inbox quando aplicável e outbox devem ser confirmados na mesma transação SQL.
- REFUND/ROLLBACK exigem referência válida e reversão integral, respeitando identidade, moeda, rodada, tipos permitidos e unicidade por tipo de reversão. Rejeite explicitamente reversão que causaria saldo negativo.
- Referências ausentes geram PENDING_REFERENCE e reprocessamento agendado com backoff exponencial e limite/TTL documentado; esgotamento gera rejeição e evento.

## Mensageria e recuperação

- Use `wager-transactions.fifo` e `wager-transactions-dlq.fifo`. Assuma entrega at-least-once, duplicatas, desordem e indisponibilidade temporária.
- Inbox persistente deduplica por `(consumerName, messageId)` e guarda payloadHash. Ack somente após commit.
- Diferencie rejeição de negócio (terminal e ack), falha transitória (retry com backoff) e permanente (DLQ); limite tentativas e implemente shutdown gracioso em SIGTERM.
- Outbox é obrigatória. Publique somente após commit, com workers concorrentes, retries e recuperação após crash. Duplicatas de publicação devem ser seguras para consumidores.
- Implemente os eventos mínimos do desafio: WagerTransactionProcessed (inclusive LOSS), WagerTransactionRejected, WalletBalanceChanged (apenas quando saldo muda) e WagerTransactionPendingReference.
- Eventos usam classe abstrata IntegrationEvent e subclasses concretas com tipo e versão; serialize MoneyProps e envelope estável com correlação e causalidade.

## Contratos e observabilidade

- Preserve endpoints e contratos da seção 9, incluindo consultas, paginação por cursor estável/opaco, reconciliação e health live/ready.
- Diferencie consistentemente payload inválido, conflito, rejeição de negócio, processamento pendente e falha transitória na API.
- Logs JSON devem incluir os identificadores de correlação aplicáveis, sem segredos, dados sensíveis ou payloads financeiros completos.
- Cubra métricas de status, duplicatas, retries, DLQ, conflitos de lock, outbox lag e latência. Readiness verifica PostgreSQL e SQS; liveness verifica o processo.
- Autenticação é opcional e não pontua: se omitida, documente desenho e ponto de extensão; se implementada, integre IdP externo, sem autenticação artesanal. Health permanece aberto; mensagens internas ainda exigem validações de domínio.
- A observabilidade obrigatória está implementada conforme o CHALLENGE.md. Preserve e mantenha logs estruturados, métricas e correlação, sem expor segredos, dados sensíveis ou payloads financeiros completos e sem introduzir dependências desnecessárias.

## Testes e validação

- Execute testes automatizados com Bun: unidades de Money, Wallet e operações, conflitos de moeda e idempotência; integração com PostgreSQL e LocalStack reais em containers.
- Verifique migrations/constraints, atomicidade, inbox/redelivery, retry/DLQ, publishers concorrentes e recuperação após reinício. Mocks não substituem integralmente banco e SQS.
- Teste paralelismo real: 50 envios da mesma aposta com um débito; duas apostas de 80.00 sobre 100.00 com apenas uma aprovada e saldo 20.00; wallets distintas; pelo menos três processos; crash após commit antes do ack; dois publishers; reversões antes da referência; reinício consistente.
- Em todos os cenários financeiros, confira saldo materializado igual ao reconstruído pelo ledger.
- Execute as validações relevantes à alteração (tipagem, lint, build e testes conforme aplicável). Informe comandos, resultados, erros e limitações; nunca declare como validado o que não executou.
- Não instale dependências nem altere configurações fora do escopo autorizado da etapa.

## Organização e legibilidade

- Use um arquivo por classe principal, interface principal de repositório, porta ou contrato independente, EntitySchema principal, mapper principal, caso de uso e evento de integração concreto.
- Tipos auxiliares pequenos podem permanecer junto do contrato ou classe a que pertencem. Enums, aliases e pequenas interfaces auxiliares não exigem arquivos individuais.
- Evite arquivos genéricos que agrupem responsabilidades independentes, fragmentação excessiva e abstrações desnecessárias.
- Use uma linha em branco entre métodos, construtores, factories e assinaturas de métodos das interfaces principais.
- Separe blocos lógicos dentro de métodos quando necessário, mantendo juntas instruções da mesma responsabilidade. Distinga validação, processamento, persistência e retorno quando forem etapas distintas.
- Separe testes, hooks e blocos de teste com linhas em branco. Organize preparação, execução e verificação com espaçamento, preservando grupos de assertions relacionadas.
- Preserve as configurações existentes do Prettier e do lint. Evite linhas em branco excessivas e comentários usados apenas como separadores.
- Aplique essas convenções também a novos controllers, DTOs, consumers, publishers, workers e testes.

## Encapsulamento das entidades de domínio

- Prefira propriedades públicas readonly para valores imutáveis simples e Value Objects comprovadamente imutáveis.
- Use campos privados nativos # para estados internos mutáveis e representações internas protegidas.
- Use getters para ler estado privado, calcular valores derivados ou fornecer cópias defensivas. Evite getters repetitivos para propriedades imutáveis simples.
- Altere estado exclusivamente por métodos de negócio, preservando invariantes financeiras e sem setters públicos que contornem essas regras.
- Preserve imutabilidade em tempo de execução quando exigida. readonly não impede mutações em JavaScript e Object.freeze não congela objetos internos recursivamente.
- Proteja datas e outras estruturas mutáveis com cópias defensivas na entrada e saída quando necessário.
- Preserve contratos públicos e use serialização explícita. Avalie enumerabilidade e os efeitos de Object.keys, spread e JSON.stringify ao mudar getters para propriedades.
- Aplique essas convenções também às classes InboxMessage, OutboxMessage e IntegrationEvent.

## Blocos de controle e métodos

- Use chaves em todos os blocos if, else, for, while e demais estruturas de controle, inclusive quando contiverem apenas uma instrução.
- Separe blocos de validação independentes com uma linha em branco.
- Declare explicitamente os tipos de retorno de métodos públicos, getters e factories das entidades de domínio.
- Mantenha métodos simples e coesos. Extraia pequenas operações para métodos auxiliares somente quando houver benefício real de legibilidade ou reutilização.
