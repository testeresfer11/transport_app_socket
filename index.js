require('dotenv').config(); // Load environment variables

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const axios = require('axios');
const cors = require('cors');
const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: '*' }
});

const LARAVEL_API_URL = 'https://users.tctechh.com/api';
const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  console.error("Missing JWT_SECRET in .env file");
  process.exit(1);
}

const clients = new Map();
const activeRequests = new Map();

// Authenticate Laravel Token
const authenticateLaravelToken = async (token) => {
  try {
    const response = await axios.get(`${LARAVEL_API_URL}/user`, {
      headers: { 'Authorization': 'Bearer ' + token }
    });

    return response.data;
  } catch (error) {
    console.log('Laravel Token Authentication Failed:', error?.response?.data || error.message);
    return null;
  }
};

// Secure Socket.IO Authentication
io.use(async (socket, next) => {
  const token = socket.handshake.query.token;

  if (!token) {
    console.log('No token provided.');
    return next(new Error('Authentication error: No token'));
  }

  const user = await authenticateLaravelToken(token);

  if (user) {
    socket.user = user; // Attach user details to socket
    // Auto-register the user in the clients map
    clients.set(user.id, socket.id);  //  auto-register socket.id
    console.log('Sanctum Token Validated and registered user ID:', user.id, 'Socket ID:', socket.id);
    return next();
  } else {
    console.log('Invalid Sanctum Token');
    return next(new Error('Authentication error: Invalid token'));
  }
});

// Function to send shipment requests
async function sendShipments(data, entities) {
  console.log('Sending shipment requests...');
  console.log('Shipment Data:', data);

  if (entities.length === 0) {
    console.log('No registered entities found.');
    return { status: 'failed', message: 'No available drivers or companies' };
  }

  console.log(`Broadcasting shipment request to ${entities.length} entities`);

  return new Promise((resolve) => {
    const shipmentId = data.id;
    const timeout = setTimeout(() => {
      console.log(`No response received for shipment ID ${shipmentId}, marking as failed`);
      resolve({ status: 'failed', message: 'No response from drivers/companies' });
      activeRequests.delete(shipmentId);
    }, 30000);

    activeRequests.set(shipmentId, { resolve, timeout, responses: [] });

    entities.forEach((entity) => {
      const socketId = clients.get(entity.user_id);
      if (socketId) {
        console.log(`Sending shipment request to Entity ID: ${entity.user_id}`);
        io.to(socketId).emit('shipment_request', data);
      }
    });
  });
}

// Add a debug endpoint to check registered clients
app.get('/debug/clients', (req, res) => {
  const clientsList = Array.from(clients.entries()).map(([userId, socketId]) => ({
    userId,
    socketId
  }));
  res.json({
    totalClients: clients.size,
    clients: clientsList
  });
});

// Handle 'shipment_created' event from Laravel
app.post('/emit', async (req, res) => {
  const { event, data } = req.body;
  console.log('Received Event:', event, 'Data:', data);

  if (event === 'shipment_created') {
      try {
        console.log('Checking if shipment is already assigned...');
        const { data: assignedData } = await axios.get(`${LARAVEL_API_URL}/shipment/${data.id}/assigned`, {
          headers: { 'Authorization': req.headers['authorization'] }
        });

        console.log('Assigned Data:', assignedData);

        if (assignedData.hasAssigned) {
          console.log('Shipment already assigned.');
          return res.send({ status: 'success' });
        }

        console.log('Fetching nearest entities...');
        const { data: nearestEntities } = await axios.get(`${LARAVEL_API_URL}/nearest-entities`, {
          params: { latitude: data.origin_lat, longitude: data.origin_long }
         
        });

        console.log('Nearest Entities:', nearestEntities);

        const nearestRegisteredEntities = ([
          ...(nearestEntities.nearestDriver || []),
          ...(nearestEntities.nearestCompany || [])
        ]).filter(entity => clients.has(entity.user_id));

        console.log('Available Drivers/Companies:', nearestRegisteredEntities);

        if (nearestRegisteredEntities.length > 0) {
          await sendShipments(data, nearestRegisteredEntities);
        } else {
          console.warn("No available drivers or companies found.");
        }

        return res.send({ status: 'success' });
      } catch (error) {
        console.error('Error in API calls:', error?.response?.data || error.message);
        return res.status(500).send({ status: 'error', message: 'Internal Server Error' });
      }
    } else if (event === 'bid_placed') {
       console.log("Full bid_placed data:", data);
      const shipmentOwnerId = data.user_id;
      console.log("Shipment owner ID:", shipmentOwnerId);
      console.log("Current clients in map:", Array.from(clients.entries()));
      const ownerSocketId = clients.get(shipmentOwnerId);
      console.log(`Socket id of user ${ownerSocketId}`);
      if (ownerSocketId) {
        io.to(ownerSocketId).emit('bid_placed', data);
        console.log(`Bid sent to owner ID ${shipmentOwnerId} via socket ${ownerSocketId}`);
      } else {
        console.log(`No socket connection found for owner ID ${shipmentOwnerId}`);
      }
       
      return res.send({ status: 'success', message: 'Bid placed successfully' });
    } else if (event === 'shipment_price_updated') {
        console.log('shipment_price_updated');

        try {
            console.log('Fetching nearest entities...');
            const { data: nearestEntities } = await axios.get(`${LARAVEL_API_URL}/nearest-entities`, {
                params: { latitude: data.origin_lat, longitude: data.origin_long },
                headers: { 'Authorization': req.headers['authorization'] }
            });

            console.log('Nearest Entities:', nearestEntities);

            // Extract nearest drivers and companies from the API response.
            // Adjust property names according to the structure of nearestEntities.
            const nearestDrivers = nearestEntities.nearestDriver || [];
            const nearestCompanies = nearestEntities.nearestCompany || [];

            // Optional: Filter out only those entities whose sockets are connected.
            // For example, if `clients` is a Map that stores connected users keyed by user_id:
            const availableDrivers = nearestDrivers.filter(entity => clients.has(entity.user_id));
            const availableCompanies = nearestCompanies.filter(entity => clients.has(entity.user_id));

            console.log('Available Drivers:', availableDrivers);
            console.log('Available Companies:', availableCompanies);

            // Optionally, send shipment data directly to available drivers/companies.
            const combinedAvailableEntities = [...availableDrivers, ...availableCompanies];
            if (combinedAvailableEntities.length > 0) {
                await sendShipments(data, combinedAvailableEntities);
            } else {
                console.warn("No available drivers or companies found.");
            }

           
            const driversIDs = nearestDrivers.map(driver => driver.user_id);
            const companiesIDs = nearestCompanies.map(company => company.user_id);

            console.log('Sending notifications with payload:', {
                shipment_id: data.shipment_id,
                drivers: driversIDs,
                companies: companiesIDs
            });

            await axios.post(`${LARAVEL_API_URL}/shipment/send-socket-notifications`, {
                shipment_id: data.shipment_id,
                drivers: driversIDs,
                companies: companiesIDs,
            }, {
                headers: { 'Authorization': req.headers['authorization'] }
            });

            console.log('Triggered Laravel API to send notifications');
            return res.send({ status: 'success' });
        } catch (error) {
            console.error('Error in shipment_price_updated handler:', error?.response?.data || error.message);
            return res.status(500).send({ status: 'error', message: 'Failed to process price update event' });
        }
    }

  res.status(400).send({ status: 'error', message: 'Unsupported event type' });
});

// Handle Socket.IO Connections
io.on('connection', (socket) => {
  console.log('A user connected with Socket ID:', socket.id);
  
  // Double-check registration if user data is available from authentication
  if (socket.user && socket.user.id) {
    clients.set(socket.user.id, socket.id);
    console.log('Connection confirmed for User ID:', socket.user.id, 'Socket ID:', socket.id);
  }

  // Keep existing register event handler for manual registration
  socket.on('register', (data) => {
    if (data.entity_id && socket.id) {
      clients.set(data.entity_id, socket.id);
      console.log('Registered Entity ID:', data.entity_id, 'Socket ID:', socket.id);
    } else {
      console.error('Missing entity_id or socket.id in register event');
    }
  });

  socket.on('update-location', async (data) => {
    console.log('Location update:', data);

    try {
      await axios.post(`${LARAVEL_API_URL}/companyDriver/location`, {
        driver_id: data.driverId,
        latitude: data.latitude,
        longitude: data.longitude,
        shipment_id: data.shipmentId,
        path: data.path || null,
      });
    } catch (error) {
      console.error('Location API Error:', error?.response?.data || error.message);
    }

    socket.to(data.shipmentId).emit('driver-location-updated', data);
  });

  socket.on('join-room', (room_id) => {
    socket.join(room_id);
    console.log(`User ${socket.id} joined room ${room_id}`);
  });

  socket.on('send-message', (data) => {
    socket.to(data.room_id).emit('new-message', data);
  });

  socket.on('typing', (data) => {
    socket.to(data.room_id).emit('typing', `${data.name} is typing...`);
  });

  socket.on('stop-typing', (data) => {
    socket.to(data.room_id).emit('stop-typing');
  });

  socket.on('shipment_response', (response) => {
    console.log('Shipment Response:', response);
    const request = activeRequests.get(response.requestId);
    if (request) {
      request.responses.push(response);
      if (request.responses.length === 1) {
        clearTimeout(request.timeout);
        request.resolve(response);
        activeRequests.delete(response.requestId);
      }
    } else {
      console.error('No request found for ID:', response.requestId);
    }
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    for (const [id, socketId] of clients.entries()) {
      if (socketId === socket.id) {
        clients.delete(id);
        console.log('Removed Entity ID:', id);
        break;
      }
    }
  });

  socket.on('error', (err) => {
    console.error('Socket Error:', err);
  });
});

// Start Server
const PORT = 4003;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});