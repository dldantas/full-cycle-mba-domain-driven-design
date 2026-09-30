import { CustomerJoinedWaitingList } from '../../events/domain-events/customer-joined-waiting-list.event';
import { SpotOfferedToWaitingCustomer } from '../../events/domain-events/spot-offered-to-waiting-customer.event';
import { CustomerId } from '../customer.entity';
import { EventSectionId } from '../event-section';
import { EventSpotId } from '../event-spot';
import { EventId } from '../event.entity';
import { WaitingListEntryStatus } from '../waiting-list-entry';
import { WaitingList } from '../waiting-list.entity';
import { initOrm } from './helpers';

describe('WaitingList Entity Unit Tests', () => {
  initOrm();

  const createWaitingList = () =>
    WaitingList.create({
      event_id: new EventId(),
      section_id: new EventSectionId(),
    });

  test('deve adicionar clientes na ordem de chegada com status PENDING', () => {
    const waitingList = createWaitingList();
    const customer1 = new CustomerId();
    const customer2 = new CustomerId();

    const entry1 = waitingList.join(customer1);
    const entry2 = waitingList.join(customer2);

    expect(waitingList.entries.size).toBe(2);
    expect(entry1.status).toBe(WaitingListEntryStatus.PENDING);
    expect(entry2.status).toBe(WaitingListEntryStatus.PENDING);
    expect(entry1.position).toBe(1);
    expect(entry2.position).toBe(2);
    expect(
      waitingList.entriesInArrivalOrder().map((e) => e.customer_id),
    ).toEqual([customer1, customer2]);
  });

  test('deve registrar o evento CustomerJoinedWaitingList ao entrar na fila', () => {
    const waitingList = createWaitingList();
    const customerId = new CustomerId();

    const entry = waitingList.join(customerId);

    expect(waitingList.events.size).toBe(1);
    const [event] = [...waitingList.events] as CustomerJoinedWaitingList[];
    expect(event).toBeInstanceOf(CustomerJoinedWaitingList);
    expect(event.aggregate_id.equals(waitingList.id)).toBe(true);
    expect(event.event_id.equals(waitingList.event_id)).toBe(true);
    expect(event.section_id.equals(waitingList.section_id)).toBe(true);
    expect(event.entry_id.equals(entry.id)).toBe(true);
    expect(event.customer_id.equals(customerId)).toBe(true);
    expect(event.position).toBe(1);
  });

  test('não deve permitir o mesmo cliente PENDING duas vezes na fila', () => {
    const waitingList = createWaitingList();
    const customerId = new CustomerId();
    waitingList.join(customerId);

    expect(() =>
      waitingList.join(new CustomerId(customerId.value)),
    ).toThrowError('Customer already in waiting list');
    expect(waitingList.entries.size).toBe(1);
  });

  test('deve permitir que um cliente já notificado entre novamente na fila', () => {
    const waitingList = createWaitingList();
    const customerId = new CustomerId();
    waitingList.join(customerId);
    waitingList.offerSpotToNextCustomer(new EventSpotId());

    const entry = waitingList.join(customerId);

    expect(entry.status).toBe(WaitingListEntryStatus.PENDING);
    expect(entry.position).toBe(2);
  });

  test('deve notificar a primeira entrada PENDING e registrar o SpotOfferedToWaitingCustomer', () => {
    const waitingList = createWaitingList();
    const customer1 = new CustomerId();
    const customer2 = new CustomerId();
    const entry1 = waitingList.join(customer1);
    const entry2 = waitingList.join(customer2);
    waitingList.clearEvents();
    const spotId = new EventSpotId();

    waitingList.offerSpotToNextCustomer(spotId);

    expect(entry1.status).toBe(WaitingListEntryStatus.NOTIFIED);
    expect(entry2.status).toBe(WaitingListEntryStatus.PENDING);
    expect(waitingList.events.size).toBe(1);
    const [event] = [...waitingList.events] as SpotOfferedToWaitingCustomer[];
    expect(event).toBeInstanceOf(SpotOfferedToWaitingCustomer);
    expect(event.aggregate_id.equals(waitingList.id)).toBe(true);
    expect(event.entry_id.equals(entry1.id)).toBe(true);
    expect(event.customer_id.equals(customer1)).toBe(true);
    expect(event.event_id.equals(waitingList.event_id)).toBe(true);
    expect(event.section_id.equals(waitingList.section_id)).toBe(true);
    expect(event.spot_id.equals(spotId)).toBe(true);
  });

  test('não deve notificar novamente uma entrada NOTIFIED', () => {
    const waitingList = createWaitingList();
    const customer1 = new CustomerId();
    const customer2 = new CustomerId();
    const entry1 = waitingList.join(customer1);
    const entry2 = waitingList.join(customer2);

    waitingList.offerSpotToNextCustomer(new EventSpotId());
    waitingList.clearEvents();
    waitingList.offerSpotToNextCustomer(new EventSpotId());

    expect(entry1.status).toBe(WaitingListEntryStatus.NOTIFIED);
    expect(entry2.status).toBe(WaitingListEntryStatus.NOTIFIED);
    const [event] = [...waitingList.events] as SpotOfferedToWaitingCustomer[];
    expect(event.customer_id.equals(customer2)).toBe(true);
  });

  test('notificar uma fila vazia não faz nada', () => {
    const waitingList = createWaitingList();

    expect(() =>
      waitingList.offerSpotToNextCustomer(new EventSpotId()),
    ).not.toThrow();
    expect(waitingList.events.size).toBe(0);
  });

  test('notificar uma fila sem entradas PENDING não faz nada', () => {
    const waitingList = createWaitingList();
    waitingList.join(new CustomerId());
    waitingList.offerSpotToNextCustomer(new EventSpotId());
    waitingList.clearEvents();

    waitingList.offerSpotToNextCustomer(new EventSpotId());

    expect(waitingList.events.size).toBe(0);
  });
});
