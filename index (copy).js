const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: '*',
  }
});

const LARAVEL_API_URL = 'http://localhost:8000/api';
const clients = {};

// Middleware setup
app.use(express.json());

// Token validation middleware for Socket.IO
io.use((socket, next) => {
    const token = socket.handshake.query.token;
    if (token) {
        // Implement token validation logic here
        next();
    } else {
        next(new Error('Authentication error'));
    }
});

// Function to handle sending shipment request with retry mechanism
async function sendShipmentRequest(data, entities, index = 0) {
    if (index >= entities.length) {
        console.log('No more entities to send the request to.');
        return;
    }

    const entity = entities[index];
    const socketId = clients[entity.user_id];
    if (socketId) {
        const entityType = entity.type;
        console.log(`Sending shipment request to ${entityType} ID: ${entity.user_id}`);

        io.to(socketId).emit('shipment_request', data);

        const response = await new Promise((resolve) => {
            const timeout = setTimeout(() => resolve(null), 300000);

            io.once('shipment_response', (res) => {
                if (res.requestId === data.id && res.entityId === entity.user_id) {
                    clearTimeout(timeout);
                    resolve(res);
                }
            });
        });

        if (response && response.accepted) {
            console.log(`${entityType} ID: ${entity.user_id} accepted the shipment.`);
            return;
        } else {
            console.log(`${entityType} ID: ${entity.user_id} did not accept the shipment.`);
            await sendShipmentRequest(data, entities, index + 1);
        }
    } else {
        console.log(`No socket ID for entity ID: ${entity.user_id}`);
        await sendShipmentRequest(data, entities, index + 1);
    }
}

// Endpoint to handle event emission from Laravel
app.post('/emit', async (req, res) => {
    const { event, data } = req.body;

    try {
        const { data: assignedData } = await axios.get(`${LARAVEL_API_URL}/shipment/${data.id}/assigned`, {
            headers: {
                'Authorization': req.headers['authorization']
            }
        });

        if (assignedData.hasAssigned) {
            return res.send({ status: 'success' });
        }

        const { data: nearestEntities } = await axios.get(`${LARAVEL_API_URL}/nearest-entities`, {
            params: {
                latitude: data.origin_lat,
                longitude: data.origin_long
            },
            headers: {
                'Authorization': req.headers['authorization']
            }
        });

        const allEntities = [
            ...(nearestEntities.nearestCompany || []).map(company => ({ ...company, type: 'company' })),
            ...(nearestEntities.nearestDriver || []).map(driver => ({ ...driver, type: 'driver' }))
        ];

        if (allEntities.length > 0) {
            await sendShipmentRequest(data, allEntities);
        }

        res.send({ status: 'success' });
    } catch (error) {
        console.error('Error fetching nearest entities:', error);
        res.status(500).send({ status: 'error', message: 'Internal Server Error' });
    }
});

// Socket.io connection handler
io.on('connection', (socket) => {
    console.log('A user connected with Socket ID:', socket.id);

    socket.on('register', (data) => {
        if (data.entity_id && socket.id) {
            clients[data.entity_id] = socket.id;
            console.log('Registered entity with ID:', data.entity_id, 'Socket ID:', socket.id);
        } else {
            console.error('Register event missing entity_id or socket.id');
        }
    });

    socket.on('disconnect', () => {
        console.log('User disconnected with Socket ID:', socket.id);
        for (const id in clients) {
            if (clients[id] === socket.id) {
                delete clients[id];
                console.log('Unregistered entity with ID:', id);
                break;
            }
        }
    });

    socket.on('shipment_response', (response) => {
        console.log('Shipment response received:', response);
        io.to(response.requesterId).emit('shipment_response', response);
    });
});

const PORT = 3001;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
