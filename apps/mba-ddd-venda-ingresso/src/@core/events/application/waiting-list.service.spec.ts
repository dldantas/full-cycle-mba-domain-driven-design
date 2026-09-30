import { EntityManager, MikroORM, MySqlDriver } from '@mikro-orm/mysql';
import {
  CustomerSchema,
  EventSchema,
  EventSectionSchema,
  EventSpotSchema,
  PartnerSchema,
  WaitingListEntrySchema,
  WaitingListSchema,
} from '../infra/db/schemas';
import { UnitOfWorkMikroOrm } from '../../common/infra/unit-of-work-mikro-orm';
import { ApplicationService } from '../../common/application/application.service';
import { DomainEventManager } from '../../common/domain/domain-event-manager';
import { CustomerMysqlRepository } from '../infra/db/repositories/customer-mysql.repository';
import { PartnerMysqlRepository } from '../infra/db/repositories/partner-mysql.repository';
import { EventMysqlRepository } from '../infra/db/repositories/event-mysql.repository';
import { WaitingListMysqlRepository } from '../infra/db/repositories/waiting-list-mysql.repository';
import { Customer, CustomerId } from '../domain/entities/customer.entity';
import { Partner } from '../domain/entities/partner.entity';
import { EventId } from '../domain/entities/event.entity';
import { EventSectionId } from '../domain/entities/event-section';
import {
  WaitingListEntry,
  WaitingListEntryStatus,
} from '../domain/entities/waiting-list-entry';
import { CustomerJoinedWaitingList } from '../domain/events/domain-events/customer-joined-waiting-list.event';
import { WaitingListService } from './waiting-list.service';

describe('WaitingListService', () => {
  let orm: MikroORM<MySqlDriver>;
  let em: EntityManager;
  let domainEventManager: DomainEventManager;
  let customerRepo: CustomerMysqlRepository;
  let partnerRepo: PartnerMysqlRepository;
  let eventRepo: EventMysqlRepository;
  let waitingListService: WaitingListService;

  beforeEach(async () => {
    orm = await MikroORM.init<MySqlDriver>({
      entities: [
        CustomerSchema,
        PartnerSchema,
        EventSchema,
        EventSectionSchema,
        EventSpotSchema,
        WaitingListSchema,
        WaitingListEntrySchema,
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
    domainEventManager = new DomainEventManager();
    waitingListService = new WaitingListService(
      new WaitingListMysqlRepository(em),
      customerRepo,
      eventRepo,
      new ApplicationService(new UnitOfWorkMikroOrm(em), domainEventManager),
    );
  });

  afterEach(async () => {
    await orm.close();
  });

  const arrange = async (options: { soldOut: boolean }) => {
    const partner = Partner.create({ name: 'Partner 1' });
    await partnerRepo.add(partner);
    const customer1 = Customer.create({
      name: 'Customer 1',
      cpf: '70375887091',
    });
    const customer2 = Customer.create({
      name: 'Customer 2',
      cpf: '99346413050',
    });
    await customerRepo.add(customer1);
    await customerRepo.add(customer2);
    const event = partner.initEvent({
      name: 'Event 1',
      description: 'Event 1',
      date: new Date(),
    });
    event.addSection({
      name: 'Section 1',
      description: 'Section 1',
      price: 100,
      total_spots: 2,
    });
    event.publishAll();
    const [section] = event.sections;
    const spots = [...section.spots];
    const spotsToReserve = options.soldOut ? spots : spots.slice(0, 1);
    spotsToReserve.forEach((spot) =>
      event.markSpotAsReserved({ section_id: section.id, spot_id: spot.id }),
    );
    await eventRepo.add(event);
    await em.flush();
    em.clear();
    return { event, section, customer1, customer2 };
  };

  test('deve entrar na fila de uma seção esgotada e registrar o evento', async () => {
    const { event, section, customer1, customer2 } = await arrange({
      soldOut: true,
    });
    const publishedEvents: CustomerJoinedWaitingList[] = [];
    domainEventManager.register(CustomerJoinedWaitingList.name, async (e) => {
      publishedEvents.push(e);
    });

    const entry1 = await waitingListService.join({
      event_id: event.id.value,
      section_id: section.id.value,
      customer_id: customer1.id.value,
    });
    em.clear();
    const entry2 = await waitingListService.join({
      event_id: event.id.value,
      section_id: section.id.value,
      customer_id: customer2.id.value,
    });
    em.clear();

    expect(entry1).toBeInstanceOf(WaitingListEntry);
    expect(entry1.status).toBe(WaitingListEntryStatus.PENDING);
    expect(entry1.position).toBe(1);
    expect(entry2.position).toBe(2);
    expect(publishedEvents).toHaveLength(2);
    expect(publishedEvents[1].customer_id.equals(customer2.id)).toBe(true);

    const entries = await waitingListService.list({
      event_id: event.id.value,
      section_id: section.id.value,
    });
    expect(entries.map((e) => [e.customer_id.value, e.status])).toEqual([
      [customer1.id.value, WaitingListEntryStatus.PENDING],
      [customer2.id.value, WaitingListEntryStatus.PENDING],
    ]);
  });

  test('deve retornar lista vazia para seção sem fila', async () => {
    const { event, section } = await arrange({ soldOut: true });

    const entries = await waitingListService.list({
      event_id: event.id.value,
      section_id: section.id.value,
    });

    expect(entries).toEqual([]);
  });

  test('deve validar cliente, evento, seção, esgotamento e duplicidade', async () => {
    const { event, section, customer1 } = await arrange({ soldOut: true });
    const input = {
      event_id: event.id.value,
      section_id: section.id.value,
      customer_id: customer1.id.value,
    };

    await expect(
      waitingListService.join({
        ...input,
        customer_id: new CustomerId().value,
      }),
    ).rejects.toThrowError('Customer not found');
    await expect(
      waitingListService.join({ ...input, event_id: new EventId().value }),
    ).rejects.toThrowError('Event not found');
    await expect(
      waitingListService.join({
        ...input,
        section_id: new EventSectionId().value,
      }),
    ).rejects.toThrowError('Section not found');

    await waitingListService.join(input);
    em.clear();
    await expect(waitingListService.join(input)).rejects.toThrowError(
      'Customer already in waiting list',
    );
  });

  test('não deve entrar na fila de uma seção com lugar disponível', async () => {
    const { event, section, customer1 } = await arrange({ soldOut: false });

    await expect(
      waitingListService.join({
        event_id: event.id.value,
        section_id: section.id.value,
        customer_id: customer1.id.value,
      }),
    ).rejects.toThrowError('Section is not sold out');
  });
});
