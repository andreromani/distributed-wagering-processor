# Decisões de arquitetura

## Etapa 2: Bun e compilação

Bun 1.x executa a aplicação, o TypeScript compiler e os testes. ESM e imports relativos .js são preservados.
O build usa tsc com experimentalDecorators e emitDecoratorMetadata, preservando metadados de tipos para NestJS e futura integração TypeORM. Não usamos bun build como substituto desse compilador.
Os testes de código-fonte rodam pelo transpiler do Bun; não devem ser considerados prova de emissão de metadados. A aplicação compilada também deve ser validada.
O desenvolvimento usa tsc --watch e Bun --watch sobre dist em terminais separados, mantendo a mesma compilação da produção.
strictPropertyInitialization está habilitado, sem exceções adicionais.
Observe foi removido por não ser necessário para liveness. Observabilidade completa, readiness e infraestrutura estão fora desta etapa.

## Etapa 3: monólito modular distribuído

Adotamos monólito modular: uma base de código, futuramente replicável em três ou mais processos com PostgreSQL e SQS compartilhados. Simplifica timebox e permite atomicidade futura entre wallet, ledger, transação financeira, inbox e outbox sem transações distribuídas. Microserviços independentes exigiriam coordenação e recuperação adicionais. Trade-off: deploy e escala por processo ficam acoplados; os módulos devem manter limites claros.

Domínio terá entidades e invariantes sem NestJS, ORM ou AWS; application orquestrará casos de uso por portas; infrastructure contém adaptadores concretos. AppModule compõe banco, SQS e HTTP. Pastas sem implementação não foram criadas. Entidades de persistência futuras serão separadas das de domínio.

TypeORM foi escolhido pela familiaridade e timebox, embora MikroORM seja preferencial no desafio. Options e DataSource reutilizam a mesma configuração validada. synchronize e migrationsRun são false. Pool de três conexões por instância; conexão de 2s e consultas de aproximadamente 2–2,5s. Valores devem ser revistos antes de carga. O Nest gerencia o shutdown do DataSource; SQSClient é destruído por lifecycle provider.
Inicialização manual permite servir liveness mesmo sem banco; readiness inicializa conexão sob demanda e serializa tentativas concorrentes. Nenhuma conexão é aberta ao importar DataSource do CLI.

PostgreSQL 16.11-alpine fixa versão e reduz tamanho local. LocalStack Community 4.14.0 precede a mudança de distribuição que exige token nas versões 2026.03+. Não usamos latest, socket Docker, conta AWS real ou serviços além de SQS.
Fonte da escolha: https://blog.localstack.cloud/localstack-for-aws-release-v-4-14-0/
Mudança de autenticação: https://blog.localstack.cloud/localstack-single-image-next-steps/

Filas obrigatórias FIFO: wager-transactions.fifo e wager-transactions-dlq.fifo.
Redrive após cinco recebimentos, visibility de 30s e long polling de 20s são parâmetros iniciais; cinco tentativas e visibility são configuráveis. Os workers futuros deverão ajustar visibilidade à duração de processamento e aplicar backoff. FIFO não garante integridade financeira: constraints e transações PostgreSQL serão responsáveis. Hook idempotente cria filas e atualiza atributos antes do marcador de readiness do container.

SQS usa endpoint/região/credenciais configurados, duas tentativas no SDK, timeout de conexão de 1s e requisição de 2s; health aplica abort de 2,5s por chamada.
Readiness consulta banco e ambas as filas; liveness não depende deles. Nenhum consumidor, publisher, outbox, inbox, worker ou regra financeira foi implementado. Transações futuras usarão controle por wallet, nunca lock global; a estratégia detalhada e constraints permanecem para a etapa financeira.

Testes reais não substituem banco ou SQS por mocks. Falha SQS é isolada com um cliente para porta indisponível. Metadados são verificados no JavaScript compilado e DI é verificada pela criação real do AppModule.

## Validação da etapa 3

Bun install, build, typecheck, lint e git diff --check concluíram com sucesso.
bun test: 4 testes aprovados; integração isolada: 3; unitários isolados: 1.
PostgreSQL e LocalStack saudáveis; filas e redrive verificadas pelos testes reais.
Hook executado duas vezes sem duplicar recursos.
Aplicação compilada iniciou com Bun; live e ready retornaram 200.
Cenário SQS isoladamente indisponível retornou 503, preservando live em 200.
Metadados design:paramtypes do controller compilado foram confirmados.
migration:show concluiu sem migrations; generate/run/revert tiveram opções do CLI verificadas, sem aplicação/reversão de migration real.

O Docker inicialmente retornou HTTP 500 na negociação API v1.56. A tentativa com API v1.45 funcionou neste ambiente:
PowerShell: $env:DOCKER_API_VERSION='1.45'; docker compose up -d
Não foi necessário trocar LocalStack por MiniStack.
Durante download/extração, a máquina ficou lenta e a primeira integração excedeu timeout; repetição após containers saudáveis passou.
