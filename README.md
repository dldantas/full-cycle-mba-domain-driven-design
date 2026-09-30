# MBA Full Cycle - Domain Driven Design

Este repositório contém o código-fonte e material didático do curso de Domain Driven Design do MBA Full Cycle.

O projeto é feito com Nestjs, mas o conteúdo é independente de linguagem ou framework.

## Pré-requisitos

- Node.js 18+
- Docker

## Executar o projeto

Suba as aplicações MySQL, RabbitMQ e Redis:

```bash
docker-compose up -d
```

Instale as dependências do Node.js:

```bash
npm install
```

Prepare o banco. O projeto não tem migrações; a CLI do MikroORM recria todas as tabelas a partir do `apps/mba-ddd-venda-ingresso/src/mikro-orm.config.ts`, incluindo `stored_event`, `waiting_list` e `waiting_list_entry`:

```bash
npx mikro-orm schema:fresh --run
```

Suba a API principal (porta 3000) e, em outro terminal, o app de e-mails (porta 3001):

```bash
npm run start:dev
npx nest start emails
```

Use o arquivo `api.http` como referência para fazer as requisições HTTP. Este arquivo funciona com a extensão [REST Client](https://marketplace.visualstudio.com/items?itemName=humao.rest-client) do VSCode. As requisições são nomeadas e os IDs são capturados das respostas, então o roteiro pode ser executado de cima para baixo em um banco limpo: parceiro → clientes A e B → evento → seção com 1 lugar → publish-all → compra pelo cliente A → cliente B entra na fila → cancelamento → consulta de lugares e da fila.

### Rodar os testes

Os testes de aplicação e de repositório rodam contra o MySQL do `docker-compose`:

```bash
npm test
```

> **Atenção:** cada teste de infraestrutura recria o schema com `orm.schema.refreshDatabase()` registrando só as entities daquele teste. Por isso, rodar a suíte derruba tabelas usadas pela API, como a `stored_event`. **Depois de rodar os testes, execute `npx mikro-orm schema:fresh --run` de novo antes de subir a API.**

## Feature: Lista de Espera de Ingressos

Um cliente cancela o pedido. Em consequência, o lugar volta a ficar disponível e, se houver fila naquela seção, o primeiro cliente pendente é avisado por e-mail de que abriu uma vaga. O aviso não reserva o lugar nem dá prioridade, e a oferta não expira: quem comprar primeiro leva.

| Método | Rota | O que faz |
| --- | --- | --- |
| `POST` | `/events/:event_id/orders/:order_id/cancel` | Cancela o pedido (responde o pedido com `status: "CANCELLED"`) |
| `POST` | `/events/:event_id/sections/:section_id/waiting-list` | Body `{ "customer_id": "..." }`. Coloca o cliente na fila de uma seção esgotada (responde a entrada `PENDING`) |
| `GET` | `/events/:event_id/sections/:section_id/waiting-list` | Entradas da fila na ordem de chegada, com seus status |

Erros seguem o padrão do projeto (`Error` com mensagem simples): `Order not found`, `Order already cancelled`, `Customer not found`, `Event not found`, `Section not found`, `Section is not sold out` e `Customer already in waiting list`.

### A cadeia completa do cancelamento

O comando `POST /events/:event_id/orders/:order_id/cancel` chama `OrderService.cancel()`, que roda dentro do `ApplicationService.run(...)`. Ele só carrega o `Order`, chama `order.cancel()` (a invariante impede cancelar duas vezes) e o devolve ao repositório com `orderRepo.add(order)`, para que o agregado entre no Unit of Work. O agregado registra o `OrderCancelled` com `id`, `status` e `event_spot_id`. Ao finalizar, o `ApplicationService` publica esse evento no `DomainEventManager`. O listener wildcard do `DomainEventsModule` grava o evento na `stored_event`, e o `ReleaseEventSpotHandler` reage. Esse handler localiza o agregado `Event` dono do lugar com `IEventRepository.findByEventSpotId()`, chama `event.markSpotAsAvailable()` (que desce por `EventSection` até o `EventSpot` e registra o `EventSpotReleased` com `event_id`, `section_id` e `spot_id`), remove a `SpotReservation` do lugar e publica os eventos do `Event`. O `EventSpotReleased` acorda a política `NotifyWaitingListHandler`. Ela carrega a `WaitingList` da seção com `findByEventAndSection()` (sem fila, termina sem efeito) e chama `waitingList.offerSpotToNextCustomer()`, que promove a primeira entrada `PENDING` para `NOTIFIED` e registra o `SpotOfferedToWaitingCustomer`. Em seguida, a política publica os eventos de domínio e os de integração da lista. O mapeamento registrado em `EventsModule.onModuleInit` converte o evento em `SpotOfferedToWaitingCustomerIntegrationEvent` (payload com `customer_id`, `event_id`, `section_id` e `spot_id`) e o enfileira na fila Bull `integration-events`. O `IntegrationEventsPublisher` existente publica o evento no RabbitMQ (`amq.direct`, routing key `SpotOfferedToWaitingCustomerIntegrationEvent`), e o `ConsumerService.handleSpotOfferedToWaitingCustomer()` do `apps/emails` o consome e loga o cliente e a seção. Ao final, o `ApplicationService` faz um único flush com pedido, lugar, trava de reserva e lista de espera. Nenhum comando conhece o próximo passo: cancelar pedido não toca o `Event` nem a `WaitingList`, e entrar na fila não notifica ninguém.

### Por que a `WaitingList` é um agregado separado do `Event`

O `Event` já é um agregado grande: ele carrega todas as seções e todos os lugares, e o curso discute justamente o custo de agregados que crescem demais, porque cada alteração carrega e trava o grafo inteiro e aumenta a disputa entre transações concorrentes. A fila de espera não participa de nenhuma invariante do `Event`. A regra de "não entrar duas vezes enquanto pendente" e a de "promover o primeiro pendente" dizem respeito só às entradas de uma seção. Colocá-la dentro do `Event` faria cada entrada na fila disputar o mesmo agregado que as compras usam, sem ganho de consistência. Por isso ela é um agregado próprio, com uma lista por evento + seção, que referencia `Event`, `EventSection` e `Customer` apenas por ID. A consistência entre os dois agregados é eventual e mediada por eventos de domínio (`EventSpotReleased` → política), como o curso recomenda para relações entre agregados. A exigência de "seção esgotada" para entrar na fila é validada no application service, lendo o `Event`, porque é uma pré-condição do caso de uso e não uma invariante que precise ficar sempre verdadeira dentro de uma transação.

### Limitações do mecanismo de eventos (documentadas, não contornadas)

O mecanismo base (`DomainEventManager`, `ApplicationService`, `UnitOfWorkMikroOrm`, `IntegrationEventsPublisher`) foi usado sem alterações. Estas são as consequências observadas:

- **Os eventos de domínio são publicados antes do commit.** No `ApplicationService.finish()`, os handlers rodam antes do `uow.commit()`, no mesmo Unit of Work da requisição. Isso é bom para a consistência: pedido cancelado, lugar liberado e fila atualizada vão no mesmo flush, e se um handler falhar nada é gravado. Em contrapartida, o comando espera todas as reações terminarem.
- **Os eventos de integração de agregados alterados em handlers precisam ser publicados pelo próprio handler.** O `finish()` lê a lista de agregados do Unit of Work antes de publicar e só publica eventos de integração dessa lista. Por isso o `NotifyWaitingListHandler` chama `publishForIntegrationEvent(waitingList)` por conta própria. O efeito colateral é que o evento de integração vai para a fila Bull antes do commit: se o flush falhar depois, o e-mail pode sair para uma mudança que não foi persistida. Resolver isso exige um outbox, que está fora do escopo.
- **A `SpotReservation` removida não gera evento de domínio**, porque o agregado não tem uma operação de domínio para isso; a remoção é feita via `ISpotReservationRepository.delete()`.

## Artefatos de design estratégico

- [Event Storming da feature (PNG)](docs/event-storming.png) e [versão editável (Excalidraw)](docs/event-storming.excalidraw)
- [Glossário de linguagem ubíqua](docs/linguagem-ubiqua.md)

## Professor

<a href="https://github.com/argentinaluiz">
    <img src="https://avatars.githubusercontent.com/u/4926329?v=4?s=100" width="100px;" alt=""/>
    <br />
    <sub>
        <b>Luiz Carlos</b>
    </sub>
</a>
