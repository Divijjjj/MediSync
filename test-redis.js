const redis = require('redis');

const client = redis.createClient({
    username: 'default',
    password: 'tly0jU3fdQ2wMtknSjCRbPUMJEHspkjx',
    socket: {
        host: 'redis-12116.c98.us-east-1-4.ec2.cloud.redislabs.com',
        port: 12116
    }
});

client.on('error', (err) => console.error('❌ Redis Error:', err));

(async () => {
    try {
        await client.connect();
        console.log('✅ Connected to Redis!');
        
        await client.set('test', 'Hello Redis');
        const value = await client.get('test');
        console.log('✅ Value:', value);
        
        await client.disconnect();
    } catch (err) {
        console.error('❌ Connection failed:', err.message);
    }
})();