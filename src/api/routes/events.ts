// Monad Validator Analytics - Event Routes
import { Router } from 'express';
import { EventController } from '../controllers/EventController';

export function createEventRoutes(eventController: EventController): Router {
  const router = Router();

  // Event listing and filtering
  router.get('/api/events/recent', eventController.getRecentEvents.bind(eventController));
  router.get('/api/events/search', eventController.searchEvents.bind(eventController));
  
  // Event analytics
  router.get('/api/events/types', eventController.getEventTypes.bind(eventController));
  router.get('/api/events/timeline', eventController.getEventTimeline.bind(eventController));
  router.get('/api/events/statistics', eventController.getEventStatistics.bind(eventController));

  return router;
} 