import { MikroORM, MySqlDriver } from '@mikro-orm/mysql';
import {
  CustomerSchema,
  EventSchema,
  EventSectionSchema,
  EventSpotSchema,
  PartnerSchema,
  WaitingListEntrySchema,
  WaitingListSchema,
} from '../../schemas';
import { Customer } from '../../../../domain/entities/customer.entity';
import { Partner } from '../../../../domain/entities/partner.entity';
import { WaitingList } from '../../../../domain/entities/waiting-list.entity';
import { WaitingListEntryStatus } from '../../../../domain/entities/waiting-list-entry';
import { EventSpotId } from '../../../../domain/entities/event-spot';
import { CustomerMysqlRepository } from '../customer-mysql.repository';
import { EventMysqlRepository } from '../event-mysql.repository';
import { PartnerMysqlRepository } from '../partner-mysql.repository';
import { WaitingListMysqlRepository } from '../waiting-list-mysql.repository';

describe('WaitingList repository', () => {
  let orm: MikroORM<MySqlDriver>;

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
  });

  afterEach(async () => {
    await orm.close();
  });

  const arrange = async () => {
    const em = orm.em.fork();
    const partnerRepo = new PartnerMysqlRepository(em);
    const customerRepo = new CustomerMysqlRepository(em);
    const eventRepo = new EventMysqlRepository(em);
    const waitingListRepo = new WaitingListMysqlRepository(em);

    const partner = Partner.create({ name: 'Partner 1' });
    await partnerRepo.add(partner);
    const event = partner.initEvent({
      name: 'Event 1',
      date: new Date(),
      description: 'Event 1 description',
    });
    event.addSection({
      name: 'Section 1',
      description: 'Section 1 description',
      price: 100,
      total_spots: 1,
    });
    event.addSection({
      name: 'Section 2',
      description: 'Section 2 description',
      price: 100,
      total_spots: 1,
    });
    await eventRepo.add(event);

    const customers = [
      Customer.create({ name: 'Customer 1', cpf: '70375887091' }),
      Customer.create({ name: 'Customer 2', cpf: '99346413050' }),
      Customer.create({ name: 'Customer 3', cpf: '59211087074' }),
    ];
    for (const customer of customers) {
      await customerRepo.add(customer);
    }
    await em.flush();

    return { em, event, customers, waitingListRepo };
  };

  test('deve persistir e recarregar a lista com as entradas na ordem de chegada', async () => {
    const { em, event, customers, waitingListRepo } = await arrange();
    const [section] = event.sections;
    const waitingList = WaitingList.create({
      event_id: event.id,
      section_id: section.id,
    });
    customers.forEach((customer) => waitingList.join(customer.id));
    waitingList.offerSpotToNextCustomer(new EventSpotId());
    await waitingListRepo.add(waitingList);
    await em.flush();
    em.clear();

    const found = await waitingListRepo.findById(waitingList.id);

    expect(found).toBeInstanceOf(WaitingList);
    expect(found.id.equals(waitingList.id)).toBe(true);
    expect(found.event_id.equals(event.id)).toBe(true);
    expect(found.section_id.equals(section.id)).toBe(true);
    expect(found.entries.size).toBe(3);
    const entries = found.entriesInArrivalOrder();
    expect(entries.map((e) => e.customer_id.value)).toEqual(
      customers.map((c) => c.id.value),
    );
    expect(entries.map((e) => e.position)).toEqual([1, 2, 3]);
    expect(entries.map((e) => e.status)).toEqual([
      WaitingListEntryStatus.NOTIFIED,
      WaitingListEntryStatus.PENDING,
      WaitingListEntryStatus.PENDING,
    ]);
    expect(entries[0].joined_at).toBeInstanceOf(Date);
  });

  test('deve buscar a lista por evento + seção', async () => {
    const { em, event, customers, waitingListRepo } = await arrange();
    const [section1, section2] = event.sections;
    const waitingList1 = WaitingList.create({
      event_id: event.id,
      section_id: section1.id,
    });
    waitingList1.join(customers[0].id);
    const waitingList2 = WaitingList.create({
      event_id: event.id,
      section_id: section2.id,
    });
    waitingList2.join(customers[1].id);
    waitingList2.join(customers[2].id);
    await waitingListRepo.add(waitingList1);
    await waitingListRepo.add(waitingList2);
    await em.flush();
    em.clear();

    const found = await waitingListRepo.findByEventAndSection(
      event.id.value,
      section2.id.value,
    );

    expect(found.id.equals(waitingList2.id)).toBe(true);
    expect(
      found.entriesInArrivalOrder().map((e) => e.customer_id.value),
    ).toEqual([customers[1].id.value, customers[2].id.value]);

    const notFound = await waitingListRepo.findByEventAndSection(
      event.id,
      new EventSpotId().value,
    );
    expect(notFound).toBeNull();
  });

  test('deve persistir alterações de uma lista recarregada', async () => {
    const { em, event, customers, waitingListRepo } = await arrange();
    const [section] = event.sections;
    const waitingList = WaitingList.create({
      event_id: event.id,
      section_id: section.id,
    });
    waitingList.join(customers[0].id);
    await waitingListRepo.add(waitingList);
    await em.flush();
    em.clear();

    const loaded = await waitingListRepo.findByEventAndSection(
      event.id,
      section.id,
    );
    loaded.join(customers[1].id);
    loaded.offerSpotToNextCustomer(new EventSpotId());
    await waitingListRepo.add(loaded);
    await em.flush();
    em.clear();

    const found = await waitingListRepo.findById(waitingList.id);
    const entries = found.entriesInArrivalOrder();
    expect(
      entries.map((e) => [e.customer_id.value, e.position, e.status]),
    ).toEqual([
      [customers[0].id.value, 1, WaitingListEntryStatus.NOTIFIED],
      [customers[1].id.value, 2, WaitingListEntryStatus.PENDING],
    ]);
  });
});
