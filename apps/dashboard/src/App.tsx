import { Layout } from '@/components/Layout';
import { AuditPage } from '@/pages/Audit';
import { DashboardPage } from '@/pages/Dashboard';
import { ErrorsPage } from '@/pages/Errors';
import { RepoDetailPage } from '@/pages/RepoDetail';
import { RepositoriesPage } from '@/pages/Repositories';
import { ReviewDetailPage } from '@/pages/ReviewDetail';
import { ReviewsPage } from '@/pages/Reviews';
import { SetupLandingPage } from '@/pages/SetupLanding';
import { SetupStatusPage } from '@/pages/SetupStatus';
import { Navigate, Route, Routes } from 'react-router-dom';

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/repositories" element={<RepositoriesPage />} />
        <Route path="/repositories/:id" element={<RepoDetailPage />} />
        <Route path="/reviews" element={<ReviewsPage />} />
        <Route path="/reviews/:id" element={<ReviewDetailPage />} />
        <Route path="/errors" element={<ErrorsPage />} />
        <Route path="/audit" element={<AuditPage />} />
        <Route path="/setup" element={<SetupLandingPage />} />
        <Route path="/setup/status" element={<SetupStatusPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
