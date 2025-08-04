const io = require('socket.io-client');
const socket = io('http://localhost:3001');

// Listen for connection confirmation
socket.on('connect', () => {
    console.log('Connected to server');
    socket.emit('register', { entity_id: 'test_entity' });

    // Simulate shipment request
    socket.emit('shipment_request', { id: 1, origin_lat: 40.7128, origin_long: -74.0060 });
});

socket.on('shipment_request', (data) => {
    console.log('Received shipment request:', data);
});
