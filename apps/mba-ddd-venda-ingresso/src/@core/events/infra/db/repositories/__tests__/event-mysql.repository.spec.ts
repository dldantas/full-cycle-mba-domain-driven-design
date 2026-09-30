import { MikroORM, MySqlDriver } from '@mikro-orm/mysql';
import {
  EventSchema,
  EventSectionSchema,
  EventSpotSchema,
  PartnerSchema,
} from '../../schemas';
import { Event } from '../../../../domain/entities/event.entity';
import { EventMysqlRepository } from '../event-mysql.repository';
import { Partner } from '../../../../domain/entities/partner.entity';
import { PartnerMysqlRepository } from '../partner-mysql.repository';
import { EventSpotId } from '../../../../domain/entities/event-spot';

test('Event repository', async () => {
  const orm = await MikroORM.init<MySqlDriver>({
    entities: [EventSchema, EventSectionSchema, EventSpotSchema, PartnerSchema],
    dbName: 'events',
    host: 'localhost',
    port: 3306,
    user: 'root',
    password: 'root',
    type: 'mysql',
    forceEntityConstructor: true,
    debug: true,
  });
  await orm.schema.refreshDatabase();
  const em = orm.em.fork();
  const partnerRepo = new PartnerMysqlRepository(em);
  const eventRepo = new EventMysqlRepository(em);

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
    total_spots: 1000,
  });

  await eventRepo.add(event);
  await em.flush();
  await em.clear();

  const eventFound = await eventRepo.findById(event.id);
  console.log(eventFound);

  await orm.close();
});

test('deve buscar o evento completo pelo id de um lugar', async () => {
  const orm = await MikroORM.init<MySqlDriver>({
    entities: [EventSchema, EventSectionSchema, EventSpotSchema, PartnerSchema],
    dbName: 'events',
    host: 'localhost',
    port: 3306,
    user: 'root',
    password: 'root',
    type: 'mysql',
    forceEntityConstructor: true,
  });
  await orm.schema.refreshDatabase();
  const em = orm.em.fork();
  const partnerRepo = new PartnerMysqlRepository(em);
  const eventRepo = new EventMysqlRepository(em);

  const partner = Partner.create({ name: 'Partner 1' });
  await partnerRepo.add(partner);
  const event1 = partner.initEvent({
    name: 'Event 1',
    date: new Date(),
    description: 'Event 1 description',
  });
  event1.addSection({
    name: 'Section 1',
    description: 'Section 1 description',
    price: 100,
    total_spots: 3,
  });
  event1.addSection({
    name: 'Section 2',
    description: 'Section 2 description',
    price: 100,
    total_spots: 2,
  });
  const event2 = partner.initEvent({
    name: 'Event 2',
    date: new Date(),
    description: 'Event 2 description',
  });
  event2.addSection({
    name: 'Section 1',
    description: 'Section 1 description',
    price: 100,
    total_spots: 2,
  });
  await eventRepo.add(event1);
  await eventRepo.add(event2);
  await em.flush();
  em.clear();

  const [, section2] = event1.sections;
  const [, spot] = section2.spots;
  const eventFound = await eventRepo.findByEventSpotId(spot.id.value);

  expect(eventFound).toBeInstanceOf(Event);
  expect(eventFound.id.equals(event1.id)).toBe(true);
  // o agregado precisa vir inteiro, e não só a seção/lugar do filtro
  expect(eventFound.sections.size).toBe(2);
  const spotsBySection = eventFound.sections.map((s) => s.spots.size).sort();
  expect(spotsBySection).toEqual([2, 3]);

  const notFound = await eventRepo.findByEventSpotId(new EventSpotId());
  expect(notFound).toBeNull();

  await orm.close();
});
