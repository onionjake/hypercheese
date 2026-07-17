// Custom entry so the background upload task is defined at module scope
// before anything renders. Android launches background tasks headlessly (no
// React tree), so the TaskManager.defineTask call must not live inside a
// component — it has to run whenever the bundle loads.
import './src/lib/background-upload';

import 'expo-router/entry';
