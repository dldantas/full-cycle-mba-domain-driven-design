# Linguagem ubíqua: Lista de Espera de Ingressos

Glossário da feature de cancelamento de pedido e lista de espera. A coluna **No código** aponta o nome usado no modelo, para que conversa e código falem a mesma língua.

| Termo | Definição | No código |
| --- | --- | --- |
| **Pedido** | Compra de um lugar por um cliente. Nasce pendente, fica pago na compra e pode ser cancelado. | `Order`, `OrderStatus` (`PENDING`, `PAID`, `CANCELLED`) |
| **Cancelamento de pedido** | Desistência da compra pelo cliente. Um pedido já cancelado não pode ser cancelado de novo. O cancelamento não devolve o lugar por conta própria: só registra o fato. | `Order.cancel()`, `OrderService.cancel()`, evento `OrderCancelled` |
| **Lugar** | Assento de uma seção, que pode estar reservado ou disponível. | `EventSpot` (`is_reserved`) |
| **Seção** | Agrupamento de lugares de um evento com o mesmo preço. É a unidade que tem lista de espera. | `EventSection` |
| **Trava de reserva** | Registro que impede dois clientes de comprar o mesmo lugar, identificado pelo lugar. É removido quando o lugar é liberado. | `SpotReservation` (chave `spot_id`) |
| **Liberação de lugar** | Devolução de um lugar reservado ao estado disponível, como reação a um pedido cancelado. Parte do agregado Evento, que localiza a seção dona do lugar. | `Event.markSpotAsAvailable()` → `EventSection.markSpotAsAvailable()` → `EventSpot.markAsAvailable()`, evento `EventSpotReleased`, `ReleaseEventSpotHandler` |
| **Seção esgotada** | Seção sem nenhum lugar disponível para reserva. É derivada da disponibilidade dos lugares, e não de contador. Só uma seção esgotada aceita entradas na lista de espera. | `Event.isSectionSoldOut()`, `EventSection.isSoldOut()` |
| **Lista de espera** | Fila de clientes interessados em uma seção esgotada. Existe uma por evento + seção. | `WaitingList` (`event_id`, `section_id`), `IWaitingListRepository.findByEventAndSection()` |
| **Entrada** | Participação de um cliente na lista de espera, com status e posição na ordem de chegada. | `WaitingListEntry` (`customer_id`, `status`, `position`, `joined_at`) |
| **Entrar na lista de espera** | Ação do cliente de se inscrever na fila de uma seção esgotada. O mesmo cliente não entra duas vezes enquanto tem entrada pendente. | `WaitingList.join()`, `WaitingListService.join()`, evento `CustomerJoinedWaitingList` |
| **Ordem de chegada** | Sequência em que os clientes entraram na fila. Define quem é avisado primeiro. | `WaitingListEntry.position`, `WaitingList.entriesInArrivalOrder()` |
| **Entrada pendente** | Entrada que ainda aguarda um lugar e não foi avisada. | `WaitingListEntryStatus.PENDING` |
| **Entrada notificada** | Entrada cujo cliente já foi avisado de uma vaga. Não é avisada de novo. | `WaitingListEntryStatus.NOTIFIED` |
| **Oferta de lugar (notificação)** | Aviso ao primeiro cliente pendente da fila de que um lugar da seção foi liberado. Só avisa: não reserva, não dá prioridade e não expira, e quem comprar primeiro leva. | `WaitingList.offerSpotToNextCustomer()`, evento `SpotOfferedToWaitingCustomer` |
| **Política de notificação da lista de espera** | Regra reativa "quando um lugar for liberado, notificar o primeiro da fila daquela seção". Sem fila ou sem entrada pendente, não faz nada. | `NotifyWaitingListHandler` |
| **Evento de integração de oferta** | Versão pública da oferta de lugar, que cruza a fronteira para o contexto de e-mails via fila `integration-events` e RabbitMQ. | `SpotOfferedToWaitingCustomerIntegrationEvent` |
| **Aviso por e-mail** | Reação do contexto de e-mails à oferta de lugar. Por enquanto é um log estruturado com cliente e seção, sem envio real. | `ConsumerService.handleSpotOfferedToWaitingCustomer()` (`apps/emails`) |
