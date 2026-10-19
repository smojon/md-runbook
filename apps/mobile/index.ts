// The polyfills load before anything else: imports run before a module's own code, so they can't
// live in a layout file (the SSH library needs Buffer and Node-style crypto when it loads).
import './src/polyfills';
import 'expo-router/entry';
