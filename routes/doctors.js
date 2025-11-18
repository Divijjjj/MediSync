const express = require('express');
const router = express.Router();
const { registerDoctor, loginDoctor } = require('../controllers/doctorsController');
const auth = require('../middleware/auth');
const doctorAuth = require('../middleware/doctorAuth');
const db = require('../db');

// Doctor registration route
router.post('/register', registerDoctor);

// Doctor login route
router.post('/login', loginDoctor);

// JWT-protected doctor profile route
router.get('/profile', auth, (req, res) => {
  res.json({ id: req.doctor.id, name: req.doctor.name });
});

// Doctor dashboard (protected)
router.get('/dashboard', doctorAuth, async (req, res) => {
  try {
    const doctor_id = req.session.doctor.id;
    const redisClient = req.app.get('redisClient');
    const cacheKey = `appointments:${doctor_id}`;
    
    // Try to get from Redis cache first
    let appointments = [];
    let fromCache = false;
    
    try {
      if (redisClient && redisClient.isOpen) {
        const cachedData = await redisClient.get(cacheKey);
        if (cachedData) {
          appointments = JSON.parse(cachedData);
          fromCache = true;
          console.log('✅ Cache HIT: Retrieved appointments for doctor', doctor_id, 'from Redis');
        } else {
          console.log('❌ Cache MISS: No cached data for doctor', doctor_id);
        }
      }
    } catch (cacheErr) {
      console.log('Redis cache error (continuing without cache):', cacheErr.message);
    }
    
    // If not in cache, query from PostgreSQL
    if (!fromCache) {
      try {
        const result = await db.query(
          `SELECT a.*, p.name as patient_name 
           FROM appointments a 
           JOIN patients p ON a.patient_id = p.id 
           WHERE a.doctor_id = $1 
           ORDER BY 
             CASE WHEN a.status = 'pending' THEN 0 ELSE 1 END,
             a.appointment_date, 
             a.start_time`,
          [doctor_id]
        );
        appointments = result.rows;
        
        // Store in Redis cache with 45 second expiration
        try {
          if (redisClient && redisClient.isOpen) {
            await redisClient.setEx(cacheKey, 45, JSON.stringify(appointments));
            console.log('💾 Cached appointments for doctor', doctor_id, 'in Redis (expires in 45s)');
          }
        } catch (cacheErr) {
          console.log('Redis cache storage error:', cacheErr.message);
        }
      } catch (err) {
        console.log('Appointments table not found or error:', err.message);
      }
    }
    
    res.render('doctors/dashboard', { 
      doctor: req.session.doctor, 
      error: null, 
      appointments: appointments,
      fromCache: fromCache // Pass to view for debugging
    });
  } catch (err) {
    console.error('Dashboard error:', err);
    res.render('doctors/dashboard', { 
      doctor: req.session.doctor, 
      error: 'Error loading appointments.', 
      appointments: [],
      fromCache: false
    });
  }
});

// Accept appointment
router.post('/appointment/:id/accept', doctorAuth, async (req, res) => {
  try {
    const appointmentId = req.params.id;
    const redisClient = req.app.get('redisClient');
    const redisPublisher = req.app.get('redisPublisher');
    
    // Get appointment details before updating
    const appointmentResult = await db.query(
      'SELECT a.*, p.id as patient_id, p.name as patient_name, d.name as doctor_name, d.specialization FROM appointments a JOIN patients p ON a.patient_id = p.id JOIN doctors d ON a.doctor_id = d.id WHERE a.id = $1',
      [appointmentId]
    );
    
    await db.query(
      'UPDATE appointments SET status = $1 WHERE id = $2',
      ['accepted', appointmentId]
    );
    
    const appointment = appointmentResult.rows[0];
    
    // Invalidate Redis cache for this doctor
    try {
      if (redisClient && redisClient.isOpen) {
        const cacheKey = `appointments:${appointment.doctor_id}`;
        await redisClient.del(cacheKey);
        console.log('🗑️  Cache INVALIDATED for doctor:', appointment.doctor_id);
      }
    } catch (cacheErr) {
      console.log('Cache invalidation error:', cacheErr.message);
    }
    
    // Publish to Redis Pub/Sub channel or use direct Socket.IO
    const eventData = {
      appointmentId: parseInt(appointmentId),
      patientId: appointment.patient_id,
      status: 'accepted',
      doctorName: appointment.doctor_name,
      specialization: appointment.specialization,
      appointmentDate: appointment.appointment_date,
      startTime: appointment.start_time,
      endTime: appointment.end_time
    };
    
    if (redisPublisher && redisPublisher.isOpen) {
      try {
        await redisPublisher.publish('appointment:updated', JSON.stringify(eventData));
        console.log('📤 Published to Redis: appointment:updated (accepted) for patient:', appointment.patient_id);
      } catch (pubErr) {
        console.log('Redis publish error:', pubErr.message);
        // Fallback to direct Socket.IO
        const io = req.app.get('io');
        io.emit('appointmentStatusUpdated', eventData);
      }
    } else {
      // No Redis - use direct Socket.IO
      const io = req.app.get('io');
      io.emit('appointmentStatusUpdated', eventData);
      console.log('📡 Direct Socket.IO: appointmentStatusUpdated (accepted) for patient:', appointment.patient_id);
    }
    
    res.redirect('/doctors/dashboard');
  } catch (err) {
    console.error('Error accepting appointment:', err);
    res.status(500).send('Error accepting appointment');
  }
});

// Reject appointment
router.post('/appointment/:id/reject', doctorAuth, async (req, res) => {
  try {
    const appointmentId = req.params.id;
    const redisClient = req.app.get('redisClient');
    const redisPublisher = req.app.get('redisPublisher');
    
    // Get appointment details before updating
    const appointmentResult = await db.query(
      'SELECT a.*, p.id as patient_id, p.name as patient_name, d.name as doctor_name, d.specialization FROM appointments a JOIN patients p ON a.patient_id = p.id JOIN doctors d ON a.doctor_id = d.id WHERE a.id = $1',
      [appointmentId]
    );
    
    await db.query(
      'UPDATE appointments SET status = $1 WHERE id = $2',
      ['rejected', appointmentId]
    );
    
    const appointment = appointmentResult.rows[0];
    
    // Invalidate Redis cache for this doctor
    try {
      if (redisClient && redisClient.isOpen) {
        const cacheKey = `appointments:${appointment.doctor_id}`;
        await redisClient.del(cacheKey);
        console.log('🗑️  Cache INVALIDATED for doctor:', appointment.doctor_id);
      }
    } catch (cacheErr) {
      console.log('Cache invalidation error:', cacheErr.message);
    }
    
    // Publish to Redis Pub/Sub channel or use direct Socket.IO
    const eventData = {
      appointmentId: parseInt(appointmentId),
      patientId: appointment.patient_id,
      status: 'rejected',
      doctorName: appointment.doctor_name,
      specialization: appointment.specialization,
      appointmentDate: appointment.appointment_date,
      startTime: appointment.start_time,
      endTime: appointment.end_time
    };
    
    if (redisPublisher && redisPublisher.isOpen) {
      try {
        await redisPublisher.publish('appointment:updated', JSON.stringify(eventData));
        console.log('📤 Published to Redis: appointment:updated (rejected) for patient:', appointment.patient_id);
      } catch (pubErr) {
        console.log('Redis publish error:', pubErr.message);
        // Fallback to direct Socket.IO
        const io = req.app.get('io');
        io.emit('appointmentStatusUpdated', eventData);
      }
    } else {
      // No Redis - use direct Socket.IO
      const io = req.app.get('io');
      io.emit('appointmentStatusUpdated', eventData);
      console.log('📡 Direct Socket.IO: appointmentStatusUpdated (rejected) for patient:', appointment.patient_id);
    }
    
    res.redirect('/doctors/dashboard');
  } catch (err) {
    console.error('Error rejecting appointment:', err);
    res.status(500).send('Error rejecting appointment');
  }
});

// Doctor Availability Status Routes
// Update doctor availability status
router.post('/status/update', doctorAuth, async (req, res) => {
  try {
    const doctorId = req.session.doctor.id;
    const doctorName = req.session.doctor.name;
    const { status } = req.body; // 'available', 'busy', or 'offline'
    
    // Validate status
    const validStatuses = ['available', 'busy', 'offline'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status. Must be available, busy, or offline.' });
    }
    
    const redisClient = req.app.get('redisClient');
    const redisPublisher = req.app.get('redisPublisher');
    
    if (redisClient && redisClient.isOpen) {
      const statusKey = `doctor:status:${doctorId}`;
      
      // Store status in Redis with 30-minute TTL (auto-offline if inactive)
      // If status is 'offline', don't set TTL
      if (status === 'offline') {
        await redisClient.set(statusKey, status);
      } else {
        await redisClient.setEx(statusKey, 1800, status); // 30 minutes TTL
      }
      
      console.log(`✅ Doctor ${doctorId} status updated to: ${status}`);
      
      // Publish status change to Redis Pub/Sub
      const statusEvent = {
        doctorId: doctorId,
        doctorName: doctorName,
        status: status,
        timestamp: new Date().toISOString()
      };
      
      if (redisPublisher && redisPublisher.isOpen) {
        await redisPublisher.publish('doctor:status:changed', JSON.stringify(statusEvent));
        console.log('📤 Published doctor:status:changed event for doctor:', doctorId);
      }
      
      res.json({ success: true, status: status });
    } else {
      res.status(503).json({ error: 'Redis unavailable' });
    }
  } catch (err) {
    console.error('Error updating doctor status:', err);
    res.status(500).json({ error: 'Failed to update status' });
  }
});

// Get doctor status
router.get('/status', doctorAuth, async (req, res) => {
  try {
    const doctorId = req.session.doctor.id;
    const redisClient = req.app.get('redisClient');
    
    if (redisClient && redisClient.isOpen) {
      const statusKey = `doctor:status:${doctorId}`;
      const status = await redisClient.get(statusKey) || 'offline';
      res.json({ status: status });
    } else {
      res.json({ status: 'offline' });
    }
  } catch (err) {
    console.error('Error getting doctor status:', err);
    res.json({ status: 'offline' });
  }
});

// Get all doctors status (for patient view)
router.get('/status/all', async (req, res) => {
  try {
    const redisClient = req.app.get('redisClient');
    const result = await db.query('SELECT id FROM doctors');
    const doctorIds = result.rows.map(row => row.id);
    
    const statuses = {};
    
    if (redisClient && redisClient.isOpen) {
      for (const id of doctorIds) {
        const statusKey = `doctor:status:${id}`;
        const status = await redisClient.get(statusKey) || 'offline';
        statuses[id] = status;
      }
    } else {
      // All offline if Redis unavailable
      doctorIds.forEach(id => statuses[id] = 'offline');
    }
    
    res.json(statuses);
  } catch (err) {
    console.error('Error getting all doctor statuses:', err);
    res.status(500).json({ error: 'Failed to get statuses' });
  }
});

module.exports = router;
