# Decisões de arquitetura

## Etapa 2: Bun e compilação

Bun 1.x executa a aplicação, o TypeScript compiler e os testes. ESM e imports relativos .js são preservados.
O build usa tsc com experimentalDecorators e emitDecoratorMetadata, preservando metadados de tipos para NestJS e futura integração TypeORM. Não usamos bun build como substituto desse compilador.
Os testes de código-fonte rodam pelo transpiler do Bun; não devem ser considerados prova de emissão de metadados. A aplicação compilada também deve ser validada.
O desenvolvimento usa tsc --watch e Bun --watch sobre dist em terminais separados, mantendo a mesma compilação da produção.
strictPropertyInitialization está habilitado, sem exceções adicionais.
Observe foi removido por não ser necessário para liveness. Observabilidade completa, readiness e infraestrutura estão fora desta etapa.
