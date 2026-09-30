import { Event } from '../event.entity';
import { PartnerId } from '../partner.entity';
import { initOrm } from './helpers';
import { EventSpotId } from '../event-spot';
import { EventSectionId } from '../event-section';
import { EventSpotReleased } from '../../events/domain-events/event-spot-released.event';

describe('Event Entity Unit Tests', () => {
  initOrm();
  it('deve criar um evento', () => {
    const event = Event.create({
      name: 'Evento 1',
      description: 'Descrição do evento 1',
      date: new Date(),
      partner_id: new PartnerId(),
    });

    event.addSection({
      name: 'Sessão 1',
      description: 'Descrição da sessão 1',
      total_spots: 100,
      price: 1000,
    });

    expect(event.sections.size).toBe(1);
    expect(event.total_spots).toBe(100);

    const [section] = event.sections;

    expect(section.spots.size).toBe(100);

    // const spot = EventSpot.create();

    // section.spots.add(spot);

    // console.dir(event.toJSON(), { depth: 10 });

    // não é valido
    // customer = new Customer({
    //   id: '123', new CustomerId() || new CustomerId('')
    //   name: 'João',
    //   cpf: '99346413050',
    // });
  });

  test('deve publicar todos os itens do evento', () => {
    const event = Event.create({
      name: 'Evento 1',
      description: 'Descrição do evento 1',
      date: new Date(),
      partner_id: new PartnerId(),
    });

    event.addSection({
      name: 'Sessão 1',
      description: 'Descrição da sessão 1',
      total_spots: 100,
      price: 1000,
    });

    event.addSection({
      name: 'Sessão 2',
      description: 'Descrição da sessão 2',
      total_spots: 1000,
      price: 50,
    });

    event.publishAll();

    expect(event.is_published).toBe(true);

    const [section1, section2] = event._sections.values();
    expect(section1.is_published).toBe(true);
    expect(section2.is_published).toBe(true);

    [...section1.spots, ...section2.spots].forEach((spot) => {
      expect(spot.is_published).toBe(true);
    });
  });

  describe('liberação de lugar', () => {
    const createPublishedEvent = (total_spots: number) => {
      const event = Event.create({
        name: 'Evento 1',
        description: 'Descrição do evento 1',
        date: new Date(),
        partner_id: new PartnerId(),
      });
      event.addSection({
        name: 'Sessão 1',
        description: 'Descrição da sessão 1',
        total_spots: 1,
        price: 1000,
      });
      event.addSection({
        name: 'Sessão 2',
        description: 'Descrição da sessão 2',
        total_spots: total_spots,
        price: 50,
      });
      event.publishAll();
      event.clearEvents();
      return event;
    };

    test('deve devolver o lugar reservado e registrar o EventSpotReleased', () => {
      const event = createPublishedEvent(2);
      const [, section] = event.sections;
      const [spot] = section.spots;
      event.markSpotAsReserved({ section_id: section.id, spot_id: spot.id });
      event.clearEvents();

      event.markSpotAsAvailable({ spot_id: spot.id });

      expect(spot.is_reserved).toBe(false);
      expect(
        event.allowReserveSpot({ section_id: section.id, spot_id: spot.id }),
      ).toBe(true);
      expect(event.events.size).toBe(1);
      const [domainEvent] = [...event.events] as EventSpotReleased[];
      expect(domainEvent).toBeInstanceOf(EventSpotReleased);
      expect(domainEvent.aggregate_id.equals(event.id)).toBe(true);
      expect(domainEvent.event_id.equals(event.id)).toBe(true);
      expect(domainEvent.section_id.equals(section.id)).toBe(true);
      expect(domainEvent.spot_id.equals(spot.id)).toBe(true);
    });

    test('deve lançar erro ao liberar um lugar que não pertence ao evento', () => {
      const event = createPublishedEvent(2);

      expect(() =>
        event.markSpotAsAvailable({ spot_id: new EventSpotId() }),
      ).toThrowError('Spot not found');
      expect(event.events.size).toBe(0);
    });

    test('deve indicar se a seção está esgotada', () => {
      const event = createPublishedEvent(2);
      const [, section] = event.sections;
      const [spot1, spot2] = section.spots;

      expect(event.isSectionSoldOut(section.id)).toBe(false);

      event.markSpotAsReserved({ section_id: section.id, spot_id: spot1.id });
      expect(event.isSectionSoldOut(section.id)).toBe(false);

      event.markSpotAsReserved({ section_id: section.id, spot_id: spot2.id });
      expect(event.isSectionSoldOut(section.id)).toBe(true);

      event.markSpotAsAvailable({ spot_id: spot2.id });
      expect(event.isSectionSoldOut(section.id)).toBe(false);
    });

    test('deve lançar erro ao verificar esgotamento de seção inexistente', () => {
      const event = createPublishedEvent(2);

      expect(() => event.isSectionSoldOut(new EventSectionId())).toThrowError(
        'Section not found',
      );
    });
  });
});
