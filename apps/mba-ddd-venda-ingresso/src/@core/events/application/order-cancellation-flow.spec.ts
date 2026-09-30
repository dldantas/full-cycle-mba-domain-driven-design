import { EntityManager, MikroORM, MySqlDriver } from '@mikro-orm/mysql';
import {
  CustomerSchema,
  EventSchema,
  EventSectionSchema,
  EventSpotSchema,
  OrderSchema,
  PartnerSchema,
  SpotReservationSchema,
  WaitingListEntrySchema,
  WaitingListSchema,
} from '../infra/db/schemas';
import { StoredEventSchema } from '../../stored-events/infra/db/schemas';
import { StoredEventMysqlRepository } from '../../stored-events/infra/db/repositories/stored-event-mysql.repository';
import { StoredEvent } from '../../stored-events/domain/entities/stored-event.entity';
import { UnitOfWorkMikroOrm } from '../../common/infra/unit-of-work-mikro-orm';
import { ApplicationService } from '../../common/application/application.service';
import { DomainEventManager } from '../../common/domain/domain-event-manager';
import { IDomainEvent } from '../../common/domain/domain-event';
import { IIntegrationEvent } from '../../common/domain/integration-event';
import { CustomerMysqlRepository } from '../infra/db/repositories/customer-mysql.repository';
import { PartnerMysqlRepository } from '../infra/db/repositories/partner-mysql.repository';
import { EventMysqlRepository } from '../infra/db/repositories/event-mysql.repository';
import { OrderMysqlRepository } from '../infra/db/repositories/order-mysql.repository';
import { SpotReservationMysqlRepository } from '../infra/db/repositories/spot-reservation-mysql.repository';
import { WaitingListMysqlRepository } from '../infra/db/repositories/waiting-list-mysql.repository';
import { Customer } from '../domain/entities/customer.entity';
import { Partner } from '../domain/entities/partner.entity';
import { Event } from '../domain/entities/event.entity';
import { EventSection } from '../domain/entities/event-section';
import { EventSpot, EventSpotId } from '../domain/entities/event-spot';
import { Order, OrderId, OrderStatus } from '../domain/entities/order.entity';
import { SpotReservation } from '../domain/entities/spot-reservation.entity';
import { WaitingListEntryStatus } from '../domain/entities/waiting-list-entry';
import { SpotOfferedToWaitingCustomer } from '../domain/events/domain-events/spot-offered-to-waiting-customer.event';
import { SpotOfferedToWaitingCustomerIntegrationEvent } from '../domain/events/integration-events/spot-offered-to-waiting-customer.int-events';
import { ReleaseEventSpotHandler } from './handlers/release-event-spot.handler';
import { NotifyWaitingListHandler } from './handlers/notify-waiting-list.handler';
import { OrderService } from './order.service';
import { WaitingListService } from './waiting-list.service';
import { PaymentGateway } from './payment.gateway';

describe('Fluxo de cancelamento de pedido -> liberação do lugar -> lista de espera', () => {
  let orm: MikroORM<MySqlDriver>;
  let em: EntityManager;
  let domainEventManager: DomainEventManager;
  let publishedDomainEvents: string[];
  let integrationEventsQueue: IIntegrationEvent[];

  let customerRepo: CustomerMysqlRepository;
  let partnerRepo: PartnerMysqlRepository;
  let eventRepo: EventMysqlRepository;
  let orderRepo: OrderMysqlRepository;
  let spotReservationRepo: SpotReservationMysqlRepository;
  let waitingListRepo: WaitingListMysqlRepository;
  let orderService: OrderService;
  let waitingListService: WaitingListService;

  beforeEach(async () => {
    orm = await MikroORM.init<MySqlDriver>({
      entities: [
        CustomerSchema,
        PartnerSchema,
        EventSchema,
        EventSectionSchema,
        EventSpotSchema,
        OrderSchema,
        SpotReservationSchema,
        WaitingListSchema,
        WaitingListEntrySchema,
        StoredEventSchema,
      ],
      dbName: 'events',
      host: 'localhost',
      port: 3306,
      user: 'root',
      password: 'root',
      type: 'mysql',
      forceEntityConstructor: true,
    });
    await orm.schema.refreshDatabase();
    em = orm.em.fork();

    customerRepo = new CustomerMysqlRepository(em);
    partnerRepo = new PartnerMysqlRepository(em);
    eventRepo = new EventMysqlRepository(em);
    orderRepo = new OrderMysqlRepository(em);
    spotReservationRepo = new SpotReservationMysqlRepository(em);
    waitingListRepo = new WaitingListMysqlRepository(em);

    domainEventManager = new DomainEventManager();
    publishedDomainEvents = [];
    integrationEventsQueue = [];

    // reproduz o DomainEventsModule.onModuleInit (grava todo evento na stored_event)
    const storedEventRepo = new StoredEventMysqlRepository(em);
    domainEventManager.register('*', async (event: IDomainEvent) => {
      publishedDomainEvents.push(event.constructor.name);
      storedEventRepo.add(event);
    });

    // reproduz o EventsModule.onModuleInit
    const releaseEventSpotHandler = new ReleaseEventSpotHandler(
      eventRepo,
      spotReservationRepo,
      domainEventManager,
    );
    ReleaseEventSpotHandler.listensTo().forEach((eventName: string) => {
      domainEventManager.register(eventName, async (event) => {
        await releaseEventSpotHandler.handle(event);
      });
    });
    const notifyWaitingListHandler = new NotifyWaitingListHandler(
      waitingListRepo,
      domainEventManager,
    );
    NotifyWaitingListHandler.listensTo().forEach((eventName: string) => {
      domainEventManager.register(eventName, async (event) => {
        await notifyWaitingListHandler.handle(event);
      });
    });
    domainEventManager.registerForIntegrationEvent(
      SpotOfferedToWaitingCustomer.name,
      async (event) => {
        const integrationEvent =
          new SpotOfferedToWaitingCustomerIntegrationEvent(event);
        // no lugar da fila Bull integration-events
        integrationEventsQueue.push(integrationEvent);
      },
    );

    const uow = new UnitOfWorkMikroOrm(em);
    const applicationService = new ApplicationService(uow, domainEventManager);
    orderService = new OrderService(
      orderRepo,
      customerRepo,
      eventRepo,
      spotReservationRepo,
      uow,
      new PaymentGateway(),
      applicationService,
    );
    waitingListService = new WaitingListService(
      waitingListRepo,
      customerRepo,
      eventRepo,
      applicationService,
    );
  });

  afterEach(async () => {
    await orm.close();
  });

  // estado depois de uma compra: lugar reservado, trava de reserva e pedido pago
  const purchase = async (
    event: Event,
    section: EventSection,
    spot: EventSpot,
    customer: Customer,
  ) => {
    event.markSpotAsReserved({ section_id: section.id, spot_id: spot.id });
    await eventRepo.add(event);
    await spotReservationRepo.add(
      SpotReservation.create({ spot_id: spot.id, customer_id: customer.id }),
    );
    const order = Order.create({
      customer_id: customer.id,
      event_spot_id: spot.id,
      amount: section.price,
    });
    order.pay();
    await orderRepo.add(order);
    return order;
  };

  const arrange = async () => {
    const partner = Partner.create({ name: 'Partner 1' });
    await partnerRepo.add(partner);
    const customerA = Customer.create({
      name: 'Customer A',
      cpf: '70375887091',
    });
    const customerB = Customer.create({
      name: 'Customer B',
      cpf: '99346413050',
    });
    const customerC = Customer.create({
      name: 'Customer C',
      cpf: '59211087074',
    });
    await customerRepo.add(customerA);
    await customerRepo.add(customerB);
    await customerRepo.add(customerC);

    const event = partner.initEvent({
      name: 'Event 1',
      description: 'Event 1',
      date: new Date(),
    });
    event.addSection({
      name: 'Section 1',
      description: 'Section 1',
      price: 100,
      total_spots: 1,
    });
    event.addSection({
      name: 'Section 2',
      description: 'Section 2',
      price: 50,
      total_spots: 1,
    });
    event.publishAll();
    const [section1, section2] = event.sections;
    const [spot1] = section1.spots;
    const [spot2] = section2.spots;

    const orderA = await purchase(event, section1, spot1, customerA);
    await purchase(event, section2, spot2, customerA);
    await em.flush();
    em.clear();

    return {
      event,
      section1,
      section2,
      spot1,
      spot2,
      orderA,
      customerA,
      customerB,
      customerC,
    };
  };

  test('um único cancelamento libera o lugar, remove a trava e notifica o primeiro da fila', async () => {
    const {
      event,
      section1,
      section2,
      spot1,
      spot2,
      orderA,
      customerB,
      customerC,
    } = await arrange();

    await waitingListService.join({
      event_id: event.id.value,
      section_id: section1.id.value,
      customer_id: customerB.id.value,
    });
    await waitingListService.join({
      event_id: event.id.value,
      section_id: section1.id.value,
      customer_id: customerC.id.value,
    });
    await waitingListService.join({
      event_id: event.id.value,
      section_id: section2.id.value,
      customer_id: customerC.id.value,
    });
    em.clear();
    publishedDomainEvents = [];

    const cancelledOrder = await orderService.cancel({
      order_id: orderA.id.value,
    });
    em.clear();

    // o comando cancelou o pedido
    expect(cancelledOrder.status).toBe(OrderStatus.CANCELLED);
    const orderFound = await orderRepo.findById(orderA.id);
    expect(orderFound.status).toBe(OrderStatus.CANCELLED);

    // a cadeia inteira reagiu a partir de um único comando
    expect(publishedDomainEvents).toEqual([
      'OrderCancelled',
      'EventSpotReleased',
      'SpotOfferedToWaitingCustomer',
    ]);

    // 1a reação: o lugar voltou a ficar disponível (e só ele)
    const eventFound = await eventRepo.findById(event.id);
    const spot1Found = eventFound.sections
      .find((s) => s.id.equals(section1.id))
      .spots.find((s) => s.id.equals(spot1.id));
    const spot2Found = eventFound.sections
      .find((s) => s.id.equals(section2.id))
      .spots.find((s) => s.id.equals(spot2.id));
    expect(spot1Found.is_reserved).toBe(false);
    expect(spot2Found.is_reserved).toBe(true);
    expect(eventFound.isSectionSoldOut(section1.id)).toBe(false);

    // 1a reação: a trava de reserva foi removida (e só a dele)
    expect(await spotReservationRepo.findById(spot1.id)).toBeNull();
    expect(await spotReservationRepo.findById(spot2.id)).not.toBeNull();

    // política: a primeira entrada PENDING da fila da seção foi notificada
    const waitingList1 = await waitingListRepo.findByEventAndSection(
      event.id,
      section1.id,
    );
    expect(
      waitingList1
        .entriesInArrivalOrder()
        .map((e) => [e.customer_id.value, e.status]),
    ).toEqual([
      [customerB.id.value, WaitingListEntryStatus.NOTIFIED],
      [customerC.id.value, WaitingListEntryStatus.PENDING],
    ]);

    // a fila de outra seção não foi tocada
    const waitingList2 = await waitingListRepo.findByEventAndSection(
      event.id,
      section2.id,
    );
    expect(waitingList2.entriesInArrivalOrder()[0].status).toBe(
      WaitingListEntryStatus.PENDING,
    );

    // evento de integração enfileirado para o contexto de e-mails
    expect(integrationEventsQueue).toHaveLength(1);
    expect(integrationEventsQueue[0].event_name).toBe(
      'SpotOfferedToWaitingCustomerIntegrationEvent',
    );
    expect(integrationEventsQueue[0].payload).toEqual({
      customer_id: customerB.id.value,
      event_id: event.id.value,
      section_id: section1.id.value,
      spot_id: spot1.id.value,
    });

    // raio-x: stored_event
    const storedEvents = await em.find(StoredEvent, {});
    const typeNames = storedEvents.map((s) => s.type_name);
    expect(typeNames).toEqual(
      expect.arrayContaining([
        'CustomerJoinedWaitingList',
        'OrderCancelled',
        'EventSpotReleased',
        'SpotOfferedToWaitingCustomer',
      ]),
    );
  });

  test('cancelamento sem fila na seção libera o lugar e não notifica ninguém', async () => {
    const { event, section1, spot1, orderA } = await arrange();

    await orderService.cancel({ order_id: orderA.id.value });
    em.clear();

    const eventFound = await eventRepo.findById(event.id);
    expect(eventFound.isSectionSoldOut(section1.id)).toBe(false);
    expect(await spotReservationRepo.findById(spot1.id)).toBeNull();
    expect(
      await waitingListRepo.findByEventAndSection(event.id, section1.id),
    ).toBeNull();
    expect(publishedDomainEvents).toEqual([
      'OrderCancelled',
      'EventSpotReleased',
    ]);
    expect(integrationEventsQueue).toHaveLength(0);
  });

  test('cancelamento com fila sem entradas PENDING não notifica ninguém', async () => {
    const { event, section1, orderA, customerB } = await arrange();
    await waitingListService.join({
      event_id: event.id.value,
      section_id: section1.id.value,
      customer_id: customerB.id.value,
    });
    const waitingList = await waitingListRepo.findByEventAndSection(
      event.id,
      section1.id,
    );
    waitingList.offerSpotToNextCustomer(new EventSpotId());
    await waitingListRepo.add(waitingList);
    await em.flush();
    em.clear();
    publishedDomainEvents = [];

    await orderService.cancel({ order_id: orderA.id.value });
    em.clear();

    expect(publishedDomainEvents).toEqual([
      'OrderCancelled',
      'EventSpotReleased',
    ]);
    expect(integrationEventsQueue).toHaveLength(0);
    const waitingListFound = await waitingListRepo.findByEventAndSection(
      event.id,
      section1.id,
    );
    expect(waitingListFound.entriesInArrivalOrder()[0].status).toBe(
      WaitingListEntryStatus.NOTIFIED,
    );
  });

  test('não deve cancelar um pedido inexistente', async () => {
    await expect(
      orderService.cancel({ order_id: new OrderId().value }),
    ).rejects.toThrowError('Order not found');
  });

  test('não deve cancelar um pedido já cancelado', async () => {
    const { orderA } = await arrange();
    await orderService.cancel({ order_id: orderA.id.value });
    em.clear();
    publishedDomainEvents = [];

    await expect(
      orderService.cancel({ order_id: orderA.id.value }),
    ).rejects.toThrowError('Order already cancelled');
    expect(publishedDomainEvents).toEqual([]);
  });
});
