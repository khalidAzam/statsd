var dgram    = require('dgram')
  , net      = require('net')
  , events   = require('events')
  , hashring = require('hashring')
  , config   = require('./proxyConfig');

var udp_version = config.udp_version
  ,       nodes = config.nodes;

var packet   = new events.EventEmitter();
var node_status = [];
var node_ring = {};

//load the node_ring object with the available nodes and a weight of 100
// weight is currently arbitrary but the same for all
nodes.forEach(function(element, index, array) {
  node_ring[element.host + ':' + element.port] = 100;
});

var ring = new hashring(
  node_ring, 'md5', {
    'max cache size': 10000,
    //We don't want duplicate keys sent so replicas set to 0
    'replicas': 0
  });

// Do an initial rount of health checks prior to starting up the server
doHealthChecks();

// Setup the udp listener
var server = dgram.createSocket(udp_version, function (msg, rinfo) {
  // Convert the raw packet to a string (defaults to UTF8 encoding)
  var packet_data = msg.toString();
  // If the packet contains a \n then it contains multiple metrics
  if (packet_data.indexOf("\n") > -1) {
    var metrics = packet_data.split("\n");
  } else {
    // metrics needs to be an array to fake it for single metric packets
    var metrics = [ packet_data ] ;
  }

  // Loop through the metrics and split on : to get mertric name for hashing
  for (var midx in metrics) {
    var bits = metrics[midx].toString().split(':');
    var key = bits.shift();
    packet.emit('send', key, msg);
  }
});

// Listen for the send message, and process the metric key and msg
packet.on('send', function(key, msg) {
  // retreives the destination for this key
  var statsd_host = ring.get(key);

  // break the retreived host to pass to the send function
  var host_config = statsd_host.split(':');

  var client = dgram.createSocket(udp_version);
  // Send the mesg to the backend
  client.send(msg, 0, msg.length, host_config[1], host_config[0], function(err, bytes) {
    client.close();
  });
});

// Bind the listening udp server to the configured port and host
server.bind(config.port, config.host || undefined);

// Set the interval for healthchecks
setInterval(doHealthChecks, config.checkInterval || 10000);

// Perform health check on all nodes
function doHealthChecks() {
  nodes.forEach(function(element, index, array) {
    healthcheck(element);
  });
}

// Perform health check on node
function healthcheck(node) {
  var node_id = node.host + ':' + node.port;
  var client = net.connect({port: node.adminport, host: node.host},
      function() {
    client.write('help\r\n');
  });
  client.on('data', function(data) {
    //could be checking data response here, but health check isn't pulled yet
    client.end();
    if (node_status[node_id] !== undefined) {
      var new_server = {};
      new_server[node_id] = 100;
      ring.add(new_server);
    }
    node_status[node_id] = 0;
  });
  client.on('error', function(e) {
    if (e.code == 'ECONNREFUSED') {
      ring.remove(node_id);
      if (node_status[node_id] === undefined) {
        node_status[node_id] = 1;
      } else if (node_status[node_id] > 0) {
        node_status[node_id]++;
      }
    } else {
      console.log('Errored with ' + e.code);
    }
  });
}
